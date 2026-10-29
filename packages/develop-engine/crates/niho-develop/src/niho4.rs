//! R395-frozen camera-scoped `niho-4` RAW preparation.

use crate::color::mat_vec_f32;
use crate::decode::{LinearImage, WorkingCopyEncoding, WorkingCopyMeta};
use crate::niho4_response::{self, Camera};
use crate::resize::{self, Filter};
use crate::settings::{DevelopSettings, WhiteBalanceMode};
use crate::spatial::{self, GainScale, Plane, Quality, Shift, SpatialParams};
use std::fmt;
use std::sync::{Arc, OnceLock, Weak};

mod transfer;
pub(crate) use transfer::{import_analysis, source_fingerprint, TransferError};

const ANALYSIS_LONG_EDGE: usize = 750;
const WORKING_COPY_MAX: f64 = 2.0;
const GAMMA: f64 = 1.8;
const PANASONIC_PRE_PROFILE_HEX: &str = include_str!("../niho4/pre-profile-panasonic-r281.hex");

#[derive(Debug)]
pub enum PrepareError {
    Chroma(crate::raw_chroma::RawChromaError),
    Detail(crate::detail::DetailError),
    Response(niho4_response::RawResponseError),
    UnsupportedCamera,
    NonFinite(&'static str),
}

impl fmt::Display for PrepareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Chroma(e) => write!(f, "CNR: {e}"),
            Self::Detail(e) => write!(f, "detail: {e}"),
            Self::Response(e) => write!(f, "H/S response: {e}"),
            Self::UnsupportedCamera => write!(f, "unsupported camera for niho-4"),
            Self::NonFinite(stage) => write!(f, "non-finite value during {stage}"),
        }
    }
}

impl std::error::Error for PrepareError {}

pub struct Prepared {
    pub image: LinearImage,
    pub meta: WorkingCopyMeta,
    pub settings: DevelopSettings,
    pub key: String,
    pub approximate_white_balance: bool,
    pub analysis: AnalysisCache,
}

/// Full-source work shared across NIHO 3 master rebuilds.  The CNR result
/// depends only on the source and the effective CNR amount; the canonical
/// response coefficients additionally depend only on that CNR result and
/// the RAW metadata's fixed baseline exposure. Both are shared with the
/// thumbnail and auto Sessions of the same source while this cache holds
/// them ([`AnalysisCache::downgrade`], #17945): the coefficients and typed
/// NIHO 7 highlight maps are set once by whichever session needs them first.
pub struct AnalysisCache {
    camera: Camera,
    cnr_amount: f64,
    luminance_nr_amount: f64,
    baseline_ev_bits: u64,
    source_width: usize,
    source_height: usize,
    source_ptr: usize,
    source_len: usize,
    cnr_source: Arc<CnrSource>,
    coefficients: Arc<OnceLock<niho4_response::CoefficientMaps>>,
    niho7_highlights: Arc<OnceLock<Result<Niho7HighlightMaps, niho4_response::RawResponseError>>>,
    preview_source: Option<PreviewSource>,
}

enum Niho7HighlightMaps {
    Residual(Vec<f32>),
    FxShoulder { a: Vec<f32>, b: Vec<f32> },
}

impl AnalysisCache {
    /// Whether [`prepare`] reuses this cache for `settings` on this exact
    /// immutable source, camera, fixed baseline and effective CNR amount.
    pub(crate) fn serves(
        &self,
        image: &LinearImage,
        settings: &DevelopSettings,
        camera: Camera,
        baseline_ev: f64,
    ) -> bool {
        self.camera == camera
            && self.cnr_amount == effective_cnr_amount(settings)
            && self.luminance_nr_amount == luminance_nr_amount(settings)
            && self.baseline_ev_bits == baseline_ev.to_bits()
            && self.source_width == image.width
            && self.source_height == image.height
            && self.source_ptr == image.data.as_ptr() as usize
            && self.source_len == image.data.len()
    }

    /// A reference that does not keep the CNR result and coefficients
    /// alive (the session holding this cache may drop them).
    pub(crate) fn downgrade(&self) -> AnalysisSeed {
        AnalysisSeed {
            camera: self.camera,
            cnr_amount: self.cnr_amount,
            luminance_nr_amount: self.luminance_nr_amount,
            baseline_ev_bits: self.baseline_ev_bits,
            source_width: self.source_width,
            source_height: self.source_height,
            source_ptr: self.source_ptr,
            source_len: self.source_len,
            cnr_source: Arc::downgrade(&self.cnr_source),
            coefficients: Arc::downgrade(&self.coefficients),
            niho7_highlights: Arc::downgrade(&self.niho7_highlights),
        }
    }
}

/// [`AnalysisCache::downgrade`].
#[derive(Clone)]
pub(crate) struct AnalysisSeed {
    camera: Camera,
    cnr_amount: f64,
    luminance_nr_amount: f64,
    baseline_ev_bits: u64,
    source_width: usize,
    source_height: usize,
    source_ptr: usize,
    source_len: usize,
    cnr_source: Weak<CnrSource>,
    coefficients: Weak<OnceLock<niho4_response::CoefficientMaps>>,
    niho7_highlights: Weak<OnceLock<Result<Niho7HighlightMaps, niho4_response::RawResponseError>>>,
}

impl AnalysisSeed {
    /// The shared cache while another session still holds it.
    pub(crate) fn upgrade(&self) -> Option<AnalysisCache> {
        Some(AnalysisCache {
            camera: self.camera,
            cnr_amount: self.cnr_amount,
            luminance_nr_amount: self.luminance_nr_amount,
            baseline_ev_bits: self.baseline_ev_bits,
            source_width: self.source_width,
            source_height: self.source_height,
            source_ptr: self.source_ptr,
            source_len: self.source_len,
            cnr_source: self.cnr_source.upgrade()?,
            coefficients: self.coefficients.upgrade()?,
            niho7_highlights: self.niho7_highlights.upgrade()?,
            preview_source: None,
        })
    }
}

/// Amount zero is exactly the immutable Session source. Keeping that state
/// instead of a second full-size allocation preserves both the CNR contract
/// and cache invalidation while the Session owns the source lifetime.
enum CnrSource {
    /// A compact transferred analysis keeps the expensive reduced
    /// coefficients and NIHO 7 maps, but not this full-size source. It is
    /// rebuilt only when a frame needs a master (or a missing map).
    Missing,
    Original,
    Filtered(Vec<f32>),
}

impl CnrSource {
    fn data<'a>(&'a self, original: &'a [f32]) -> &'a [f32] {
        match self {
            Self::Missing => unreachable!("CNR source is hydrated before it is read"),
            Self::Original => original,
            Self::Filtered(data) => data,
        }
    }
}

/// A reduced CNR-complete source used only to prepare an unframed
/// Interactive master. The full CNR source and its canonical analysis stay
/// authoritative.
struct PreviewSource {
    cnr_amount: f64,
    width: usize,
    height: usize,
    filter: Filter,
    data: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparationTarget {
    pub width: usize,
    pub height: usize,
    pub filter: Filter,
}

fn effective_cnr_amount(settings: &DevelopSettings) -> f64 {
    settings
        .detail
        .and_then(|detail| detail.color_noise_reduction)
        .unwrap_or_else(|| settings.color_noise_reduction.min(50.0))
}

fn luminance_nr_amount(settings: &DevelopSettings) -> f64 {
    settings
        .detail
        .map_or(0.0, |detail| detail.luminance_noise_reduction)
}

pub(crate) fn camera(meta: &WorkingCopyMeta) -> Option<Camera> {
    match meta {
        WorkingCopyMeta::Raw { dcp_sha256, .. } => Camera::from_calibration(dcp_sha256),
        WorkingCopyMeta::Raster { .. } => None,
    }
}

pub fn preparation_key(
    camera: Camera,
    meta: &WorkingCopyMeta,
    settings: &DevelopSettings,
    white_balance: Option<[[f32; 3]; 3]>,
    target: Option<PreparationTarget>,
) -> String {
    let baseline = match meta {
        WorkingCopyMeta::Raw { baseline_ev, .. } => *baseline_ev,
        WorkingCopyMeta::Raster { .. } => 0.0,
    };
    let target = match target {
        Some(target) => format!(
            "preview:{}x{}:{:?}",
            target.width, target.height, target.filter
        ),
        None => "full".to_owned(),
    };
    format!(
        "{}|{camera:?}|{baseline}|{}|{}|{}|{}|{}|{:?}|{}|{target}",
        if settings.engine == crate::settings::ENGINE_NIHO_5 {
            "niho5"
        } else if matches!(
            settings.engine.as_str(),
            crate::settings::ENGINE_NIHO_7 | crate::settings::ENGINE_NIHO_11
        ) {
            "niho7"
        } else {
            "niho4"
        },
        effective_cnr_amount(settings),
        luminance_nr_amount(settings),
        settings.highlights.min(0.0),
        settings.shadows.max(0.0),
        settings.texture,
        white_balance,
        settings.exposure,
    )
}

/// What of the response analysis a preparation reads: the canonical
/// response coefficients (Highlights or Shadows used) and the NIHO 7
/// highlight maps (Highlights used by niho-7 / niho-11).
#[derive(Clone, Copy)]
struct AnalysisNeeds {
    coefficients: bool,
    niho7_highlights: bool,
}

impl AnalysisNeeds {
    fn of(settings: &DevelopSettings) -> Self {
        Self {
            coefficients: settings.highlights < 0.0 || settings.shadows > 0.0,
            niho7_highlights: uses_niho7_highlights(settings),
        }
    }
}

fn uses_niho7_highlights(settings: &DevelopSettings) -> bool {
    uses_niho7_engine(settings) && settings.highlights < 0.0
}

fn uses_niho7_engine(settings: &DevelopSettings) -> bool {
    matches!(
        settings.engine.as_str(),
        crate::settings::ENGINE_NIHO_7 | crate::settings::ENGINE_NIHO_11
    )
}

/// The response analysis of `settings` (CNR source, then what `needs` asks
/// for), reusing `cached` when it serves them. The coefficients and maps
/// are set in `cached`'s shared cells, so the sessions sharing it see them.
fn make_analysis(
    image: &LinearImage,
    meta: &WorkingCopyMeta,
    settings: &DevelopSettings,
    camera: Camera,
    cached_analysis: Option<AnalysisCache>,
    needs: AnalysisNeeds,
    needs_cnr_source: bool,
) -> Result<AnalysisCache, PrepareError> {
    let baseline_ev = match meta {
        WorkingCopyMeta::Raw { baseline_ev, .. } => *baseline_ev,
        WorkingCopyMeta::Raster { .. } => 0.0,
    };
    let cnr_amount = effective_cnr_amount(settings);
    let luminance_nr_amount = luminance_nr_amount(settings);
    let mut analysis = if let Some(cached) = cached_analysis.filter(|cached| {
        cached.camera == camera
            && cached.cnr_amount == cnr_amount
            && cached.luminance_nr_amount == luminance_nr_amount
            && cached.baseline_ev_bits == baseline_ev.to_bits()
            && cached.source_width == image.width
            && cached.source_height == image.height
            && cached.source_ptr == image.data.as_ptr() as usize
            && cached.source_len == image.data.len()
    }) {
        cached
    } else {
        let cnr_source = make_cnr_source(image, settings, cnr_amount, luminance_nr_amount)?;
        AnalysisCache {
            camera,
            cnr_amount,
            luminance_nr_amount,
            baseline_ev_bits: baseline_ev.to_bits(),
            source_width: image.width,
            source_height: image.height,
            source_ptr: image.data.as_ptr() as usize,
            source_len: image.data.len(),
            cnr_source,
            coefficients: Arc::default(),
            niho7_highlights: Arc::default(),
            preview_source: None,
        }
    };

    let missing_coefficients = needs.coefficients && analysis.coefficients.get().is_none();
    let missing_niho7 = needs.niho7_highlights && analysis.niho7_highlights.get().is_none();
    if matches!(analysis.cnr_source.as_ref(), CnrSource::Missing)
        && (needs_cnr_source || missing_coefficients || missing_niho7)
    {
        analysis.cnr_source = make_cnr_source(image, settings, cnr_amount, luminance_nr_amount)?;
    }

    // Canonical analysis must finish before allocating the full prepared
    // master (or preview source), so its full-size quantized copy never
    // overlaps an otherwise unnecessary clone of the CNR source.
    if needs.coefficients && analysis.coefficients.get().is_none() {
        let (canonical, width, height) = analysis_copy(
            analysis.cnr_source.data(&image.data),
            image.width,
            image.height,
            baseline_ev,
        );
        let coefficients = niho4_response::coefficient_maps(camera, &canonical, width, height)
            .map_err(PrepareError::Response)?;
        // Set here unless another session sharing it set the same maps.
        let _ = analysis.coefficients.set(coefficients);
    }

    if needs.niho7_highlights && analysis.niho7_highlights.get().is_none() {
        let coefficients = analysis.coefficients.get().expect("response coefficients");
        let source = analysis.cnr_source.data(&image.data);
        let maps = match camera {
            Camera::SonyIlmeFx30 => crate::raw_highlight_shoulder::maps(
                source,
                image.width,
                image.height,
                baseline_ev,
                coefficients,
            )
            .map(|(a, b)| Niho7HighlightMaps::FxShoulder { a, b }),
            Camera::PanasonicDcS5 | Camera::SonyZvE10m2 => crate::raw_highlight_residual::base_map(
                source,
                image.width,
                image.height,
                baseline_ev,
                coefficients,
            )
            .map(Niho7HighlightMaps::Residual),
        };
        // A shared derived session may have initialized the identical maps.
        let _ = analysis.niho7_highlights.set(maps);
    }

    Ok(analysis)
}

fn make_cnr_source(
    image: &LinearImage,
    settings: &DevelopSettings,
    cnr_amount: f64,
    luminance_nr_amount: f64,
) -> Result<Arc<CnrSource>, PrepareError> {
    if cnr_amount == 0.0 && luminance_nr_amount == 0.0 {
        crate::raw_chroma::validate(&image.data, image.width, image.height, cnr_amount)
            .map_err(PrepareError::Chroma)?;
        return Ok(Arc::new(CnrSource::Original));
    }
    let chroma = if cnr_amount == 0.0 {
        image.data.clone()
    } else {
        crate::detail::reduce_raw_chroma(&image.data, image.width, image.height, settings)
            .map_err(PrepareError::Chroma)?
    };
    Ok(Arc::new(CnrSource::Filtered(
        crate::detail::reduce_noise(
            &chroma,
            image.width,
            image.height,
            image.width.max(image.height),
            crate::detail::SourceSpace::LinearProPhoto,
            settings.detail.unwrap_or_default(),
            None,
        )
        .map_err(PrepareError::Detail)?,
    )))
}

/// Makes ahead the response analysis frames of `settings`' engine and noise
/// reduction read once they use Highlights or Shadows (#129: while the
/// editor is idle), so the first such frame does not wait for it. It is the
/// analysis [`prepare`] makes: given back as `cached_analysis`, the frames
/// are the same bytes. A `cached_analysis` that serves is filled in place.
pub fn prepare_analysis(
    image: &LinearImage,
    meta: &WorkingCopyMeta,
    settings: &DevelopSettings,
    cached_analysis: Option<AnalysisCache>,
) -> Result<AnalysisCache, PrepareError> {
    let camera = camera(meta).ok_or(PrepareError::UnsupportedCamera)?;
    make_analysis(
        image,
        meta,
        settings,
        camera,
        cached_analysis,
        AnalysisNeeds {
            coefficients: true,
            niho7_highlights: uses_niho7_engine(settings),
        },
        false,
    )
}

impl AnalysisCache {
    /// Whether [`prepare_analysis`] of `settings`, which this cache serves,
    /// would only find what it makes: the response coefficients and, for
    /// niho-7 / niho-11, the NIHO 7 highlight maps are made.
    pub(crate) fn holds(&self, settings: &DevelopSettings) -> bool {
        self.coefficients.get().is_some()
            && (!uses_niho7_engine(settings) || self.niho7_highlights.get().is_some())
    }
}

/// Prepares a signed RAW master from the full CNR/analysis cache. `target`
/// reduces that CNR-complete source before the display-only controls; `None`
/// preserves the frozen full-source preparation order.
pub fn prepare(
    image: &LinearImage,
    meta: &WorkingCopyMeta,
    settings: &DevelopSettings,
    white_balance: Option<[[f32; 3]; 3]>,
    approximate_white_balance: bool,
    target: Option<PreparationTarget>,
    cached_analysis: Option<AnalysisCache>,
) -> Result<Prepared, PrepareError> {
    let camera = camera(meta).ok_or(PrepareError::UnsupportedCamera)?;
    let baseline_ev = match meta {
        WorkingCopyMeta::Raw { baseline_ev, .. } => *baseline_ev,
        WorkingCopyMeta::Raster { .. } => 0.0,
    };
    let key = preparation_key(camera, meta, settings, white_balance, target);
    let cnr_amount = effective_cnr_amount(settings);
    let uses_niho7_highlights = uses_niho7_highlights(settings);
    let mut analysis = make_analysis(
        image,
        meta,
        settings,
        camera,
        cached_analysis,
        AnalysisNeeds::of(settings),
        true,
    )?;

    // Detect on the immutable full-resolution signed CNR source before the
    // NIHO 5 pre-H reconstruction mutates a prepared master. A preview gets
    // only a resized mask; its feature maps remain the full-source canonical
    // maps cached above. FX uses physical luminance headroom; the other two
    // cameras retain the frozen ceiling-relative R23 residual mask.
    let niho7_mask = if uses_niho7_highlights {
        if let WorkingCopyMeta::Raw {
            encoding: Some(WorkingCopyEncoding::SignedGamma18V1 { ceiling }),
            ..
        } = meta
        {
            let source = analysis.cnr_source.data(&image.data);
            let source_mask = match camera {
                Camera::SonyIlmeFx30 => crate::raw_highlight_shoulder::mask_weights(
                    source,
                    image.width,
                    image.height,
                    baseline_ev,
                ),
                Camera::PanasonicDcS5 | Camera::SonyZvE10m2 => {
                    crate::raw_highlight_recovery::mask_weights(
                        source,
                        image.width,
                        image.height,
                        *ceiling as f32,
                    )
                }
            };
            Some(match target {
                Some(target) => resize_plane_bilinear(
                    &source_mask,
                    image.width,
                    image.height,
                    target.width,
                    target.height,
                ),
                None => source_mask,
            })
        } else {
            None
        }
    } else {
        None
    };

    let (prepare_width, prepare_height, mut data) = match target {
        None => (
            image.width,
            image.height,
            analysis.cnr_source.data(&image.data).to_vec(),
        ),
        Some(target) => {
            let matches = analysis.preview_source.as_ref().is_some_and(|cached| {
                cached.cnr_amount == cnr_amount
                    && cached.width == target.width
                    && cached.height == target.height
                    && cached.filter == target.filter
            });
            if !matches {
                analysis.preview_source = Some(PreviewSource {
                    cnr_amount,
                    width: target.width,
                    height: target.height,
                    filter: target.filter,
                    data: resize::resample(
                        analysis.cnr_source.data(&image.data),
                        image.width,
                        image.height,
                        target.width,
                        target.height,
                        target.filter,
                    ),
                });
            }
            let preview = analysis.preview_source.as_ref().expect("preview source");
            (preview.width, preview.height, preview.data.clone())
        }
    };

    if matches!(
        settings.engine.as_str(),
        crate::settings::ENGINE_NIHO_5
            | crate::settings::ENGINE_NIHO_7
            | crate::settings::ENGINE_NIHO_11
    ) && settings.highlights < 0.0
    {
        if let WorkingCopyMeta::Raw {
            encoding: Some(WorkingCopyEncoding::SignedGamma18V1 { ceiling }),
            ..
        } = meta
        {
            crate::raw_highlight_recovery::apply(
                &mut data,
                prepare_width,
                prepare_height,
                *ceiling as f32,
                (-settings.highlights / 100.0) as f32,
            );
        }
    }

    if settings.highlights < 0.0 || settings.shadows > 0.0 {
        let coefficients = analysis.coefficients.get().expect("response coefficients");
        let (highlight_gains, shadow_gains) = niho4_response::gain_ev_components(
            coefficients,
            settings.highlights.min(0.0) as f32,
            settings.shadows.max(0.0) as f32,
        )
        .map_err(PrepareError::Response)?;
        // Preserve the frozen renderer's operation order: H first, then S.
        let shadow_interaction = niho4_response::shadow_interaction_scale(
            camera,
            settings.highlights.min(0.0) as f32,
            settings.shadows.max(0.0) as f32,
        );
        if settings.highlights < 0.0 {
            let mut highlight_gains = resize_plane_bilinear(
                &highlight_gains,
                coefficients.width,
                coefficients.height,
                prepare_width,
                prepare_height,
            );
            let fx_shoulder = if uses_niho7_highlights {
                let maps = analysis
                    .niho7_highlights
                    .get()
                    .expect("NIHO 7 highlight maps")
                    .as_ref()
                    .map_err(|error| PrepareError::Response(error.clone()))?;
                match maps {
                    Niho7HighlightMaps::Residual(residual) => {
                        let residual = resize_plane_bilinear(
                            residual,
                            coefficients.width,
                            coefficients.height,
                            prepare_width,
                            prepare_height,
                        );
                        crate::raw_highlight_residual::apply_to_gains(
                            &mut highlight_gains,
                            &residual,
                            niho7_mask.as_deref().expect("signed NIHO 7 mask"),
                            settings.highlights as f32,
                        );
                        None
                    }
                    Niho7HighlightMaps::FxShoulder { a, b } => Some((
                        resize_plane_bilinear(
                            a,
                            coefficients.width,
                            coefficients.height,
                            prepare_width,
                            prepare_height,
                        ),
                        resize_plane_bilinear(
                            b,
                            coefficients.width,
                            coefficients.height,
                            prepare_width,
                            prepare_height,
                        ),
                    )),
                }
            } else {
                None
            };
            debug_assert_eq!(highlight_gains.len(), prepare_width * prepare_height);
            debug_assert_eq!(
                niho7_mask.as_ref().map(Vec::len),
                uses_niho7_highlights.then_some(prepare_width * prepare_height)
            );
            if let Some((a, b)) = &fx_shoulder {
                debug_assert_eq!(a.len(), prepare_width * prepare_height);
                debug_assert_eq!(b.len(), prepare_width * prepare_height);
            }
            let highlight_alpha = resize_plane_bilinear(
                &coefficients.highlight_alpha,
                coefficients.width,
                coefficients.height,
                prepare_width,
                prepare_height,
            );
            let baseline_exposure = libm::exp2(baseline_ev) as f32;
            let h = (-settings.highlights / 100.0) as f32;
            // Each pixel reads only its own values, so rows may run on
            // different threads (#150).
            crate::par::for_each_row_mut(&mut data, prepare_width * 3, |y, row| {
                let first = y * prepare_width;
                for (x, pixel) in row.chunks_exact_mut(3).enumerate() {
                    let index = first + x;
                    let pre = [pixel[0], pixel[1], pixel[2]];
                    let old = bounded_highlight_pixel(
                        pre,
                        highlight_gains[index],
                        highlight_alpha[index],
                    );
                    let highlighted = match &fx_shoulder {
                        Some((a, b)) => crate::raw_highlight_shoulder::apply_pixel(
                            pre,
                            old,
                            a[index],
                            b[index],
                            niho7_mask.as_ref().expect("signed NIHO 7 mask")[index],
                            h,
                            baseline_exposure,
                        ),
                        None => old,
                    };
                    pixel.copy_from_slice(&highlighted);
                }
            });
        }
        if settings.shadows > 0.0 {
            let shadow_gains = resize_plane_bilinear(
                &shadow_gains,
                coefficients.width,
                coefficients.height,
                prepare_width,
                prepare_height,
            );
            crate::par::for_each_row_mut(&mut data, prepare_width * 3, |y, row| {
                let gains = &shadow_gains[y * prepare_width..];
                for (pixel, shadow_gain) in row.chunks_exact_mut(3).zip(gains) {
                    let scale = libm::exp2f(shadow_gain * shadow_interaction);
                    pixel[0] *= scale;
                    pixel[1] *= scale;
                    pixel[2] *= scale;
                }
            });
        }
    }

    let exposure = libm::exp2(baseline_ev + settings.exposure) as f32;
    if !exposure.is_finite() {
        return Err(PrepareError::NonFinite("exposure"));
    }
    crate::par::for_each_row_mut(&mut data, prepare_width * 3, |_, row| {
        for pixel in row.chunks_exact_mut(3) {
            let mut value = [pixel[0], pixel[1], pixel[2]];
            if let Some(matrix) = &white_balance {
                value = mat_vec_f32(matrix, value);
            }
            for channel in 0..3 {
                pixel[channel] = value[channel] * exposure;
            }
        }
    });

    if settings.texture != 0.0 {
        apply_rgb_texture(
            &mut data,
            prepare_width,
            prepare_height,
            settings.texture * 1.5,
        );
    }
    if data.iter().any(|v| !v.is_finite()) {
        return Err(PrepareError::NonFinite("master preparation"));
    }

    let downstream = downstream_settings(settings);
    Ok(Prepared {
        image: LinearImage {
            width: prepare_width,
            height: prepare_height,
            data,
        },
        meta: match meta {
            WorkingCopyMeta::Raw {
                as_shot_white,
                as_shot_white_adobe,
                dcp_sha256,
                look_table_included,
                encoding,
                ..
            } => WorkingCopyMeta::Raw {
                baseline_ev: 0.0,
                as_shot_white: *as_shot_white,
                as_shot_white_adobe: *as_shot_white_adobe,
                white_balance_table: None,
                dcp_sha256: dcp_sha256.clone(),
                look_table_included: *look_table_included,
                encoding: *encoding,
            },
            WorkingCopyMeta::Raster { icc_sha256 } => WorkingCopyMeta::Raster {
                icc_sha256: icc_sha256.clone(),
            },
        },
        settings: downstream,
        key,
        approximate_white_balance,
        analysis,
    })
}

/// Removes only controls already baked into the prepared master. This is
/// recomputed for every frame so tail-only slider changes never read a stale
/// settings snapshot from the master cache.
pub(crate) fn downstream_settings(settings: &DevelopSettings) -> DevelopSettings {
    let mut downstream = settings.clone();
    downstream.exposure = 0.0;
    downstream.texture = 0.0;
    if downstream.highlights < 0.0 {
        downstream.highlights = 0.0;
    }
    if downstream.shadows > 0.0 {
        downstream.shadows = 0.0;
    }
    if downstream.white_balance.mode == WhiteBalanceMode::Absolute {
        downstream.white_balance.mode = WhiteBalanceMode::AsShot;
        downstream.white_balance.temperature = None;
        downstream.white_balance.tint = None;
    }
    downstream
}

fn bounded_highlight_pixel(pixel: [f32; 3], gain: f32, alpha: f32) -> [f32; 3] {
    let scale = libm::exp2f(gain);
    let chroma_scale = if alpha == 1.0 {
        scale
    } else {
        libm::exp2f(gain * alpha)
    };
    if chroma_scale == scale {
        return pixel.map(|value| value * scale);
    }
    let y = pixel[0] * 0.2880402 + pixel[1] * 0.7118741 + pixel[2] * 0.0000857;
    pixel.map(|value| value * scale + (value - y) * (chroma_scale - scale))
}

fn analysis_copy(
    source: &[f32],
    width: usize,
    height: usize,
    baseline_ev: f64,
) -> (Vec<f32>, usize, usize) {
    let exposure = libm::exp2(baseline_ev) as f32;
    // Do not pay the decision-table initialization cost for a small first
    // source. Both paths use the same frozen quantization boundaries.
    let encoder = if source.len() >= 1_000_000 {
        Some(analysis_encoder())
    } else {
        ANALYSIS_ENCODER.get()
    };
    let decode = analysis_decode_table();
    let quantized: Vec<f32> = source
        .iter()
        .map(|value| quantize_analysis_sample(*value, exposure, encoder, decode))
        .collect();
    let (out_width, out_height) = analysis_size(width, height);
    let output = resize::resample(
        &quantized,
        width,
        height,
        out_width,
        out_height,
        Filter::Area,
    );
    (output, out_width, out_height)
}

/// The size of the canonical analysis copy (and so of the response
/// coefficients and the NIHO 7 highlight maps) of a `width` x `height`
/// source: its long edge reduced to [`ANALYSIS_LONG_EDGE`].
fn analysis_size(width: usize, height: usize) -> (usize, usize) {
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

#[inline]
fn analysis_code_reference(value: f32) -> usize {
    let encoded = libm::pow(
        f64::from(value).clamp(0.0, WORKING_COPY_MAX) / WORKING_COPY_MAX,
        1.0 / GAMMA,
    );
    libm::round(encoded * 65535.0) as usize
}

#[inline]
fn quantize_analysis_sample(
    value: f32,
    exposure: f32,
    encoder: Option<&AnalysisEncoder>,
    decode: &[f32],
) -> f32 {
    let code = match encoder {
        Some(encoder) => encoder.encode(value),
        None => analysis_code_reference(value),
    };
    decode[code] * exposure
}

const ANALYSIS_ENCODE_BINS: usize = 65536;
static ANALYSIS_ENCODER: OnceLock<AnalysisEncoder> = OnceLock::new();

/// First f32 input mapping to each unsigned 16-bit code. The inverse power
/// only seeds the search: the frozen forward pow/round expression decides
/// every boundary, including adjacent f32 inputs on either side.
struct AnalysisEncoder {
    thresholds: Box<[f32]>,
    bin_starts: Box<[u16]>,
}

impl AnalysisEncoder {
    fn new() -> Self {
        let mut thresholds = Vec::with_capacity(65535);
        let mut previous = 0;
        for code in 1..=65535 {
            let guess = (WORKING_COPY_MAX * libm::pow((code as f64 - 0.5) / 65535.0, GAMMA)) as f32;
            let mut bits = guess.to_bits().max(previous);
            while bits > previous && analysis_code_reference(f32::from_bits(bits - 1)) >= code {
                bits -= 1;
            }
            while analysis_code_reference(f32::from_bits(bits)) < code {
                bits += 1;
            }
            previous = bits;
            thresholds.push(f32::from_bits(bits));
        }
        let bin_starts = (0..=ANALYSIS_ENCODE_BINS)
            .map(|i| {
                let x = i as f32 / 32768.0;
                thresholds.partition_point(|threshold| *threshold <= x) as u16
            })
            .collect::<Vec<_>>()
            .into_boxed_slice();
        Self {
            thresholds: thresholds.into_boxed_slice(),
            bin_starts,
        }
    }

    #[inline]
    fn encode(&self, value: f32) -> usize {
        if value.is_nan() || value <= 0.0 {
            return 0;
        }
        if value >= WORKING_COPY_MAX as f32 {
            return 65535;
        }
        // Power-of-two scaling gives exact bin endpoints. Search only the
        // code interval in this bin; near zero a bin spans many codes.
        let bin = (value * 32768.0) as usize;
        let mut low = self.bin_starts[bin] as usize;
        let mut high = self.bin_starts[bin + 1] as usize;
        while low < high {
            let middle = low + (high - low) / 2;
            if self.thresholds[middle] <= value {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        low
    }
}

fn analysis_encoder() -> &'static AnalysisEncoder {
    ANALYSIS_ENCODER.get_or_init(AnalysisEncoder::new)
}

/// Exact decoded values of the frozen unsigned 16-bit gamma-1.8 analysis
/// copy. The code-dependent `pow` is memoized; the f64-to-f32 cast and
/// exposure multiplication retain their original order.
fn analysis_decode_table() -> &'static [f32] {
    static TABLE: OnceLock<Box<[f32]>> = OnceLock::new();
    TABLE.get_or_init(|| {
        (0..=65535)
            .map(|code| (WORKING_COPY_MAX * libm::pow(code as f64 / 65535.0, GAMMA)) as f32)
            .collect::<Vec<_>>()
            .into_boxed_slice()
    })
}

fn resize_plane_bilinear(
    source: &[f32],
    in_width: usize,
    in_height: usize,
    out_width: usize,
    out_height: usize,
) -> Vec<f32> {
    let mut output = vec![0.0; out_width * out_height];
    let scale_x = in_width as f64 / out_width as f64;
    let scale_y = in_height as f64 / out_height as f64;
    // Rows read only the source, so they may run on different threads (#150).
    crate::par::for_each_row_mut(&mut output, out_width, |y, row| {
        let sy = ((y as f64 + 0.5) * scale_y - 0.5).clamp(0.0, (in_height - 1) as f64);
        let y0 = libm::floor(sy) as usize;
        let y1 = (y0 + 1).min(in_height - 1);
        let ty = (sy - y0 as f64) as f32;
        for (x, value) in row.iter_mut().enumerate() {
            let sx = ((x as f64 + 0.5) * scale_x - 0.5).clamp(0.0, (in_width - 1) as f64);
            let x0 = libm::floor(sx) as usize;
            let x1 = (x0 + 1).min(in_width - 1);
            let tx = (sx - x0 as f64) as f32;
            let top = source[y0 * in_width + x0]
                + tx * (source[y0 * in_width + x1] - source[y0 * in_width + x0]);
            let bottom = source[y1 * in_width + x0]
                + tx * (source[y1 * in_width + x1] - source[y1 * in_width + x0]);
            *value = top + ty * (bottom - top);
        }
    });
    output
}

fn apply_rgb_texture(data: &mut [f32], width: usize, height: usize, amount: f64) {
    let params = SpatialParams {
        highlights: 0.0,
        shadows: 0.0,
        texture: amount,
        clarity: 0.0,
        scale_px: spatial::scale_px(width.max(height) as f64),
        long_edge: width.max(height),
        gain_scale: GainScale::IDENTITY,
        shift: Shift::default(),
        quality: Quality::Final,
    };
    for channel in 0..3 {
        let ln0 = Plane {
            width,
            height,
            data: data
                .chunks_exact(3)
                .map(|pixel| libm::log2f(pixel[channel].max(3e-5)))
                .collect(),
        };
        if let Some(filtered) = spatial::spatial_luminance(&ln0, &params) {
            for ((pixel, after), before) in
                data.chunks_exact_mut(3).zip(filtered.data).zip(ln0.data)
            {
                pixel[channel] *= libm::exp2f(after - before);
            }
        }
    }
}

fn read_f32(bytes: &[u8], index: usize) -> f32 {
    let offset = index * 4;
    f32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("embedded f32"))
}

fn profile_lut_bytes(mut value: [f32; 3], bytes: &[u8]) -> [f32; 3] {
    debug_assert_eq!(bytes.len(), 9 * 9 * 9 * 3 * 4);
    value = value.map(|v| v.clamp(0.0, 1.0));
    let position = value.map(|v| v * 8.0);
    let cell = position.map(|v| (v as usize).min(7));
    let fraction = [
        position[0] - cell[0] as f32,
        position[1] - cell[1] as f32,
        position[2] - cell[2] as f32,
    ];
    let mut delta = [0.0; 3];
    for corner in 0..8 {
        let mut at = [0; 3];
        let mut weight = 1.0;
        for axis in 0..3 {
            let bit = (corner >> axis) & 1;
            at[axis] = cell[axis] + bit;
            weight *= if bit == 0 {
                1.0 - fraction[axis]
            } else {
                fraction[axis]
            };
        }
        let index = ((at[0] * 9 + at[1]) * 9 + at[2]) * 3;
        for (channel, value) in delta.iter_mut().enumerate() {
            *value += weight * read_f32(bytes, index + channel);
        }
    }
    [
        (value[0] + delta[0]).clamp(0.0, 1.0),
        (value[1] + delta[1]).clamp(0.0, 1.0),
        (value[2] + delta[2]).clamp(0.0, 1.0),
    ]
}

/// Panasonic R281 fixed basis correction, placed exactly after ACR3 and
/// before the unchanged NIHO 3 creative tail. Sony has no correction here.
pub(crate) fn pre_profile(camera: Camera, value: [f32; 3]) -> [f32; 3] {
    if camera != Camera::PanasonicDcS5 {
        return value;
    }
    use crate::color::{mat_vec, srgb_decode, srgb_encode, PROPHOTO_TO_SRGB, SRGB_TO_PROPHOTO};
    static BYTES: OnceLock<Box<[u8]>> = OnceLock::new();
    let bytes = BYTES.get_or_init(|| {
        let hex: Vec<u8> = PANASONIC_PRE_PROFILE_HEX
            .bytes()
            .filter(|byte| !byte.is_ascii_whitespace())
            .collect();
        assert_eq!(hex.len(), 9 * 9 * 9 * 3 * 4 * 2);
        hex.chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).expect("embedded pre-profile hex");
                u8::from_str_radix(text, 16).expect("embedded pre-profile byte")
            })
            .collect::<Vec<_>>()
            .into_boxed_slice()
    });
    let rgb = mat_vec(&PROPHOTO_TO_SRGB, value.map(f64::from));
    let clipped = rgb.map(|channel| channel.clamp(0.0, 1.0));
    let transformed = profile_lut_bytes(clipped.map(|channel| srgb_encode(channel) as f32), bytes);
    let corrected = std::array::from_fn(|channel| {
        rgb[channel] + srgb_decode(f64::from(transformed[channel])) - clipped[channel]
    });
    mat_vec(&SRGB_TO_PROPHOTO, corrected).map(|channel| channel as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quantize_reference(value: f32, exposure: f32) -> f32 {
        let encoded = libm::pow(
            f64::from(value).clamp(0.0, WORKING_COPY_MAX) / WORKING_COPY_MAX,
            1.0 / GAMMA,
        );
        let code = libm::round(encoded * 65535.0);
        (WORKING_COPY_MAX * libm::pow(code / 65535.0, GAMMA)) as f32 * exposure
    }

    #[test]
    fn analysis_decode_memoization_is_bit_exact() {
        for (code, actual) in analysis_decode_table().iter().enumerate() {
            let expected = (WORKING_COPY_MAX * libm::pow(code as f64 / 65535.0, GAMMA)) as f32;
            assert_eq!(actual.to_bits(), expected.to_bits(), "code {code}");
        }

        let mut samples = vec![f32::from_bits(1), -2.0, -0.0, 0.0, 1.0, 2.0, f32::MAX];
        let mut bits = 0x243f_6a88u32;
        for _ in 0..100_000 {
            bits = bits.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let value = f32::from_bits(bits);
            if value.is_finite() {
                samples.push(value);
            }
        }
        for baseline_ev in [-8.0, 0.0, 0.25, 8.0] {
            let exposure = libm::exp2(baseline_ev) as f32;
            for value in &samples {
                for encoder in [None, Some(analysis_encoder())] {
                    assert_eq!(
                        quantize_analysis_sample(
                            *value,
                            exposure,
                            encoder,
                            analysis_decode_table()
                        )
                        .to_bits(),
                        quantize_reference(*value, exposure).to_bits(),
                        "value {value:?}, baseline {baseline_ev}"
                    );
                }
            }
        }
    }

    #[test]
    fn analysis_encoder_matches_every_rounding_boundary_and_uniform_bin() {
        let encoder = analysis_encoder();
        for &threshold in &encoder.thresholds {
            let bits = threshold.to_bits();
            for nearby in bits - 3..=bits + 3 {
                let value = f32::from_bits(nearby);
                assert_eq!(
                    encoder.encode(value),
                    analysis_code_reference(value),
                    "{value:?}"
                );
            }
        }
        for bin in 0..=ANALYSIS_ENCODE_BINS {
            let bits = (bin as f32 / 32768.0).to_bits();
            for nearby in bits.saturating_sub(1)..=bits + 1 {
                let value = f32::from_bits(nearby);
                assert_eq!(
                    encoder.encode(value),
                    analysis_code_reference(value),
                    "{value:?}"
                );
            }
        }
        let mut state = 0x65a1_3057u32;
        for _ in 0..250_000 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let value = (state as f64 / u32::MAX as f64 * WORKING_COPY_MAX) as f32;
            assert_eq!(
                encoder.encode(value),
                analysis_code_reference(value),
                "{value:?}"
            );
        }
    }

    #[test]
    fn zero_cnr_cache_borrows_session_source_and_invalidates_across_amounts() {
        let image = LinearImage {
            width: 3,
            height: 2,
            data: vec![
                -0.1, 0.2, 1.4, 0.4, 0.3, 0.2, 2.1, 0.5, -0.2, 0.7, 0.8, 0.9, 0.1, 0.2, 0.3, 0.9,
                1.0, 1.1,
            ],
        };
        let meta = WorkingCopyMeta::Raw {
            baseline_ev: 0.0,
            as_shot_white: crate::decode::AsShotWhite {
                x: 0.3127,
                y: 0.329,
                temperature: Some(5500.0),
                tint: Some(0.0),
            },
            as_shot_white_adobe: None,
            white_balance_table: None,
            dcp_sha256: "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4".into(),
            look_table_included: false,
            encoding: Some(crate::decode::WorkingCopyEncoding::SignedGamma18V1 { ceiling: 4.0 }),
        };
        let mut settings = DevelopSettings::neutral();

        let zero = prepare(&image, &meta, &settings, None, false, None, None).unwrap();
        assert!(matches!(&*zero.analysis.cnr_source, CnrSource::Original));
        assert_eq!(zero.image.data, image.data);

        settings.color_noise_reduction = 25.0;
        let filtered = prepare(
            &image,
            &meta,
            &settings,
            None,
            false,
            None,
            Some(zero.analysis),
        )
        .unwrap();
        assert!(matches!(
            &*filtered.analysis.cnr_source,
            CnrSource::Filtered(_)
        ));

        settings.color_noise_reduction = 0.0;
        let restored = prepare(
            &image,
            &meta,
            &settings,
            None,
            false,
            None,
            Some(filtered.analysis),
        )
        .unwrap();
        assert!(matches!(
            &*restored.analysis.cnr_source,
            CnrSource::Original
        ));
        assert_eq!(restored.image.data, image.data);

        let invalid_length = LinearImage {
            width: 1,
            height: 1,
            data: vec![0.0, 0.0],
        };
        assert!(matches!(
            prepare(&invalid_length, &meta, &settings, None, false, None, None),
            Err(PrepareError::Chroma(
                crate::raw_chroma::RawChromaError::InvalidLength { .. }
            ))
        ));
        let non_finite = LinearImage {
            width: 1,
            height: 1,
            data: vec![0.0, f32::NAN, 0.0],
        };
        assert!(matches!(
            prepare(&non_finite, &meta, &settings, None, false, None, None),
            Err(PrepareError::Chroma(
                crate::raw_chroma::RawChromaError::NonFiniteInput(1)
            ))
        ));
        settings.color_noise_reduction = -1.0;
        assert!(matches!(
            prepare(&image, &meta, &settings, None, false, None, None),
            Err(PrepareError::Chroma(
                crate::raw_chroma::RawChromaError::InvalidAmount(-1.0)
            ))
        ));
    }

    #[test]
    fn niho7_key_cache_drag_and_weak_seed_contracts() {
        let (width, height) = (32, 24);
        let mut data = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let u = x as f32 / width as f32;
                let v = y as f32 / height as f32;
                data.extend_from_slice(&[-0.05 + u, 0.1 + v, 0.2 + 0.5 * u]);
            }
        }
        let image = LinearImage {
            width,
            height,
            data,
        };
        let meta = WorkingCopyMeta::Raw {
            baseline_ev: -0.25,
            as_shot_white: crate::decode::AsShotWhite {
                x: 0.3127,
                y: 0.329,
                temperature: Some(5500.0),
                tint: Some(0.0),
            },
            as_shot_white_adobe: None,
            white_balance_table: None,
            dcp_sha256: "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4".into(),
            look_table_included: false,
            encoding: Some(crate::decode::WorkingCopyEncoding::SignedGamma18V1 { ceiling: 4.0 }),
        };
        let camera = camera(&meta).unwrap();
        let mut niho5 = DevelopSettings::neutral();
        niho5.engine = crate::settings::ENGINE_NIHO_5.into();
        niho5.look = crate::settings::LOOK_NIHO_STANDARD_4.into();
        niho5.highlights = -40.0;
        let mut niho7 = niho5.clone();
        niho7.engine = crate::settings::ENGINE_NIHO_7.into();
        niho7.look = crate::settings::LOOK_NIHO_STANDARD_5.into();
        assert_ne!(
            preparation_key(camera, &meta, &niho5, None, None),
            preparation_key(camera, &meta, &niho7, None, None)
        );

        let old5 = prepare(&image, &meta, &niho5, None, false, None, None).unwrap();
        assert!(old5.analysis.niho7_highlights.get().is_none());
        niho7.highlights = 0.0;
        let h0 = prepare(
            &image,
            &meta,
            &niho7,
            None,
            false,
            None,
            Some(old5.analysis),
        )
        .unwrap();
        assert!(h0.analysis.niho7_highlights.get().is_none());

        niho7.highlights = -40.0;
        let first = prepare(&image, &meta, &niho7, None, false, None, Some(h0.analysis)).unwrap();
        assert!(matches!(
            first.analysis.niho7_highlights.get(),
            Some(Ok(Niho7HighlightMaps::Residual(_)))
        ));
        let added = Arc::clone(&first.analysis.niho7_highlights);

        niho7.highlights = -80.0;
        let second = prepare(
            &image,
            &meta,
            &niho7,
            None,
            false,
            None,
            Some(first.analysis),
        )
        .unwrap();
        assert!(Arc::ptr_eq(&added, &second.analysis.niho7_highlights));

        let seed = second.analysis.downgrade();
        let shared = seed.upgrade().expect("source cache remains alive");
        assert!(Arc::ptr_eq(&added, &shared.niho7_highlights));

        let mut niho4 = niho5.clone();
        niho4.engine = crate::settings::ENGINE_NIHO_4.into();
        niho4.look = crate::settings::LOOK_NIHO_STANDARD_3.into();
        for old in [&niho5, &niho4] {
            let cached = prepare(&image, &meta, old, None, false, None, seed.upgrade()).unwrap();
            let fresh = prepare(&image, &meta, old, None, false, None, None).unwrap();
            assert_eq!(cached.image.data, fresh.image.data);
        }

        niho7.color_noise_reduction = 25.0;
        let changed = prepare(&image, &meta, &niho7, None, false, None, Some(shared)).unwrap();
        assert!(!Arc::ptr_eq(&added, &changed.analysis.niho7_highlights));
        assert!(matches!(
            changed.analysis.niho7_highlights.get(),
            Some(Ok(Niho7HighlightMaps::Residual(_)))
        ));

        let cnr_maps = Arc::clone(&changed.analysis.niho7_highlights);
        let mut changed_baseline = meta.clone();
        if let WorkingCopyMeta::Raw { baseline_ev, .. } = &mut changed_baseline {
            *baseline_ev = -0.5;
        }
        let baseline = prepare(
            &image,
            &changed_baseline,
            &niho7,
            None,
            false,
            None,
            Some(changed.analysis),
        )
        .unwrap();
        assert!(!Arc::ptr_eq(&cnr_maps, &baseline.analysis.niho7_highlights));

        let cloned_source = image.clone();
        let baseline_maps = Arc::clone(&baseline.analysis.niho7_highlights);
        let source_changed = prepare(
            &cloned_source,
            &changed_baseline,
            &niho7,
            None,
            false,
            None,
            Some(baseline.analysis),
        )
        .unwrap();
        assert!(!Arc::ptr_eq(
            &baseline_maps,
            &source_changed.analysis.niho7_highlights
        ));

        let mut fx_meta = changed_baseline.clone();
        if let WorkingCopyMeta::Raw { dcp_sha256, .. } = &mut fx_meta {
            *dcp_sha256 = "apple-ciraw8/linear-prophoto-d50/cal-sony-ilme-fx30-apple-v2".into();
        }
        let residual_maps = Arc::clone(&source_changed.analysis.niho7_highlights);
        let fx = prepare(
            &cloned_source,
            &fx_meta,
            &niho7,
            None,
            false,
            None,
            Some(source_changed.analysis),
        )
        .unwrap();
        assert!(!Arc::ptr_eq(&residual_maps, &fx.analysis.niho7_highlights));
        assert!(matches!(
            fx.analysis.niho7_highlights.get(),
            Some(Ok(Niho7HighlightMaps::FxShoulder { .. }))
        ));
    }
}
