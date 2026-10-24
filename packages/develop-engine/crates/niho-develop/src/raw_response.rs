//! Frozen NIHO 3 source-only highlight/shadow model.
//!
//! The input is an area-resized canonical analysis image (long edge 750),
//! after baseline exposure, in linear ProPhoto RGB.  Resize, white balance,
//! exposure, and render-pipeline integration intentionally live outside this
//! module.  The embedded coefficients are a representation-only export of the
//! frozen R181 highlight and R205 shadow NPZ files. The JSON asset is a
//! representation-only export produced by `tools/export_niho3_assets.py`.

use serde_json::Value;
use std::fmt;
use std::sync::OnceLock;

pub const FEATURE_COUNT: usize = 26;
const WEIGHT_COUNT: usize = 1082;
const MODEL_JSON: &str = include_str!("../niho3/response-models.json");
const MODEL_SCHEMA: &str = "niho.raw-response-models.v2";
const MODEL_LAYOUT: [[usize; 2]; 6] = [[26, 24], [24, 1], [24, 16], [16, 1], [16, 2], [2, 1]];

/// SHA-256 of the frozen feature implementation used to define this port.
pub const FEATURE_SOURCE_SHA256: &str =
    "32ffd22017f6d42155fc6826c2f9def0cfcffd895b8a1a89d841d5b87f88277a";
/// SHA-256 of the frozen R181 highlight NPZ.
pub const HIGHLIGHT_MODEL_SHA256: &str =
    "8043fdd763326d1255c45d65636c6613ec4c7698cbc8268b1880cd4b58af00ee";
/// SHA-256 of the frozen R205 shadow NPZ.
pub const SHADOW_MODEL_SHA256: &str =
    "dbef6b8c687412852e6001282ebec50ce92b5830fbcc411b85ee51da461c20bc";

/// Frozen feature order from `round100_features.py`.
pub const FEATURE_NAMES: [&str; FEATURE_COUNT] = [
    "logY",
    "meanLogY",
    "logY-mean",
    "logPeak-logY",
    "logY-localLog4",
    "localLog4-mean",
    "logArithmetic4-localLog",
    "logY-localLog16",
    "localLog16-mean",
    "logArithmetic16-localLog",
    "logY-localLog64",
    "localLog64-mean",
    "logArithmetic64-localLog",
    "logY-localLog128",
    "localLog128-mean",
    "logArithmetic128-localLog",
    "q10-mean",
    "q25-mean",
    "q50-mean",
    "q75-mean",
    "q90-mean",
    "q95-mean",
    "q99-mean",
    "rgbFraction0",
    "rgbFraction1",
    "rankY",
];

/// Four non-negative coefficient maps produced independently of H/S amounts.
#[derive(Clone, Debug)]
pub struct CoefficientMaps {
    pub width: usize,
    pub height: usize,
    pub highlight_a: Vec<f32>,
    pub highlight_b: Vec<f32>,
    pub shadow_a: Vec<f32>,
    pub shadow_b: Vec<f32>,
}

/// Coefficients and the combined per-pixel exposure gain for requested amounts.
#[derive(Clone, Debug)]
pub struct RawResponse {
    pub coefficients: CoefficientMaps,
    pub gain_ev: Vec<f32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RawResponseError {
    InvalidDimensions { width: usize, height: usize },
    InvalidInputLength { expected: usize, actual: usize },
    NonFiniteInput { index: usize },
    InvalidCoefficient { map: &'static str, index: usize },
    NonFiniteFeature { pixel: usize, feature: usize },
    InvalidHighlights(f32),
    InvalidShadows(f32),
    EmbeddedModel(String),
}

impl fmt::Display for RawResponseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDimensions { width, height } => {
                write!(f, "invalid dimensions: {width}x{height}")
            }
            Self::InvalidInputLength { expected, actual } => {
                write!(f, "invalid RGB length: expected {expected}, got {actual}")
            }
            Self::NonFiniteInput { index } => {
                write!(f, "non-finite RGB sample at index {index}")
            }
            Self::InvalidCoefficient { map, index } => {
                write!(f, "invalid {map} coefficient at {index}")
            }
            Self::NonFiniteFeature { pixel, feature } => {
                write!(f, "non-finite derived feature {feature} at pixel {pixel}")
            }
            Self::InvalidHighlights(value) => {
                write!(f, "highlights must be finite and in [-100, 0], got {value}")
            }
            Self::InvalidShadows(value) => {
                write!(f, "shadows must be finite and in [0, 100], got {value}")
            }
            Self::EmbeddedModel(message) => write!(f, "invalid embedded response model: {message}"),
        }
    }
}

impl std::error::Error for RawResponseError {}

/// Computes the frozen highlight/shadow coefficient maps.
pub fn coefficient_maps(
    linear_prophoto_rgb: &[f32],
    width: usize,
    height: usize,
) -> Result<CoefficientMaps, RawResponseError> {
    let pixels = validate_input(linear_prophoto_rgb, width, height)?;
    let features = extract_features(linear_prophoto_rgb, width, height);
    validate_features(&features)?;
    let (highlight_model, shadow_model) = models()?;

    let mut highlight_a = Vec::with_capacity(pixels);
    let mut highlight_b = Vec::with_capacity(pixels);
    let mut shadow_a = Vec::with_capacity(pixels);
    let mut shadow_b = Vec::with_capacity(pixels);
    for feature in &features {
        let [ha, hb] = highlight_model.infer(feature);
        let [sa, sb] = shadow_model.infer(feature);
        highlight_a.push(ha as f32);
        highlight_b.push(hb as f32);
        shadow_a.push(sa as f32);
        shadow_b.push(sb as f32);
    }
    Ok(CoefficientMaps {
        width,
        height,
        highlight_a,
        highlight_b,
        shadow_a,
        shadow_b,
    })
}

/// Exposes the frozen feature vectors for parity diagnostics.
pub fn feature_vectors(
    linear_prophoto_rgb: &[f32],
    width: usize,
    height: usize,
) -> Result<Vec<[f32; FEATURE_COUNT]>, RawResponseError> {
    validate_input(linear_prophoto_rgb, width, height)?;
    let features = extract_features(linear_prophoto_rgb, width, height);
    validate_features(&features)?;
    Ok(features)
}

/// [`feature_vectors`] with the local levels' means made on planes reduced
/// by `reductions` (`niho-14`, [`crate::niho14_analysis`]).
pub(crate) fn feature_vectors_reduced(
    linear_prophoto_rgb: &[f32],
    width: usize,
    height: usize,
    reductions: [usize; 4],
) -> Result<Vec<[f32; FEATURE_COUNT]>, RawResponseError> {
    validate_input(linear_prophoto_rgb, width, height)?;
    let features = extract_features_with(linear_prophoto_rgb, width, height, reductions);
    validate_features(&features)?;
    Ok(features)
}

/// Evaluates the frozen highlight and shadow responses independently.
///
/// `highlights` is in `[-100, 0]`; `shadows` is in `[0, 100]`.
pub fn gain_ev_components(
    coefficients: &CoefficientMaps,
    highlights: f32,
    shadows: f32,
) -> Result<(Vec<f32>, Vec<f32>), RawResponseError> {
    validate_amounts(highlights, shadows)?;
    let pixels = coefficients.width.checked_mul(coefficients.height).ok_or(
        RawResponseError::InvalidDimensions {
            width: coefficients.width,
            height: coefficients.height,
        },
    )?;
    if coefficients.width == 0 || coefficients.height == 0 {
        return Err(RawResponseError::InvalidDimensions {
            width: coefficients.width,
            height: coefficients.height,
        });
    }
    for (name, map) in [
        ("highlight_a", &coefficients.highlight_a),
        ("highlight_b", &coefficients.highlight_b),
        ("shadow_a", &coefficients.shadow_a),
        ("shadow_b", &coefficients.shadow_b),
    ] {
        if let Some(index) = map
            .iter()
            .position(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(RawResponseError::InvalidCoefficient { map: name, index });
        }
        if map.len() != pixels {
            return Err(RawResponseError::InvalidInputLength {
                expected: pixels,
                actual: map.len(),
            });
        }
    }

    let h = f64::from(-highlights) / 100.0;
    let s = f64::from(shadows) / 100.0;
    let mut highlight_gain = Vec::with_capacity(pixels);
    let mut shadow_gain = Vec::with_capacity(pixels);
    for index in 0..pixels {
        let highlight = (h * f64::from(coefficients.highlight_a[index])
            + h * h * f64::from(coefficients.highlight_b[index]))
        .clamp(0.0, 8.0);
        let shadow = (s * f64::from(coefficients.shadow_a[index])
            + s * s * f64::from(coefficients.shadow_b[index]))
        .clamp(0.0, 4.0);
        highlight_gain.push(-(highlight as f32));
        shadow_gain.push(shadow as f32);
    }
    Ok((highlight_gain, shadow_gain))
}

/// Combines coefficient maps into exposure gain using Lightroom-style amounts.
pub fn gain_ev(
    coefficients: &CoefficientMaps,
    highlights: f32,
    shadows: f32,
) -> Result<Vec<f32>, RawResponseError> {
    let (highlights, shadows) = gain_ev_components(coefficients, highlights, shadows)?;
    Ok(highlights
        .into_iter()
        .zip(shadows)
        .map(|(highlight, shadow)| highlight + shadow)
        .collect())
}

/// Computes coefficient maps and their combined gain in one call.
pub fn evaluate(
    linear_prophoto_rgb: &[f32],
    width: usize,
    height: usize,
    highlights: f32,
    shadows: f32,
) -> Result<RawResponse, RawResponseError> {
    validate_amounts(highlights, shadows)?;
    let coefficients = coefficient_maps(linear_prophoto_rgb, width, height)?;
    let gain_ev = gain_ev(&coefficients, highlights, shadows)?;
    Ok(RawResponse {
        coefficients,
        gain_ev,
    })
}

fn validate_features(features: &[[f32; FEATURE_COUNT]]) -> Result<(), RawResponseError> {
    for (pixel, values) in features.iter().enumerate() {
        if let Some(feature) = values.iter().position(|value| !value.is_finite()) {
            return Err(RawResponseError::NonFiniteFeature { pixel, feature });
        }
    }
    Ok(())
}

fn validate_input(input: &[f32], width: usize, height: usize) -> Result<usize, RawResponseError> {
    if width == 0 || height == 0 {
        return Err(RawResponseError::InvalidDimensions { width, height });
    }
    let pixels = width
        .checked_mul(height)
        .ok_or(RawResponseError::InvalidDimensions { width, height })?;
    let expected = pixels
        .checked_mul(3)
        .ok_or(RawResponseError::InvalidDimensions { width, height })?;
    if input.len() != expected {
        return Err(RawResponseError::InvalidInputLength {
            expected,
            actual: input.len(),
        });
    }
    if let Some(index) = input.iter().position(|value| !value.is_finite()) {
        return Err(RawResponseError::NonFiniteInput { index });
    }
    Ok(pixels)
}

fn validate_amounts(highlights: f32, shadows: f32) -> Result<(), RawResponseError> {
    if !highlights.is_finite() || !(-100.0..=0.0).contains(&highlights) {
        return Err(RawResponseError::InvalidHighlights(highlights));
    }
    if !shadows.is_finite() || !(0.0..=100.0).contains(&shadows) {
        return Err(RawResponseError::InvalidShadows(shadows));
    }
    Ok(())
}

fn extract_features(input: &[f32], width: usize, height: usize) -> Vec<[f32; FEATURE_COUNT]> {
    extract_features_with(input, width, height, [1; 4])
}

/// The local levels' blur sizes (σ, in analysis pixels).
const LOCAL_SIGMAS: [usize; 4] = [4, 16, 64, 128];

/// [`extract_features`] with level `i`'s local means made on the planes
/// reduced by `reductions[i]` (1: the frozen full-size blur).
fn extract_features_with(
    input: &[f32],
    width: usize,
    height: usize,
    reductions: [usize; 4],
) -> Vec<[f32; FEATURE_COUNT]> {
    let blurred = gaussian_blur(input, width, height, 3, 1.0, 4, Border::Reflect101);
    let pixels = width * height;
    let mut y = Vec::with_capacity(pixels);
    let mut ln = Vec::with_capacity(pixels);
    let mut features = vec![[0.0; FEATURE_COUNT]; pixels];
    for index in 0..pixels {
        let r = blurred[index * 3];
        let g = blurred[index * 3 + 1];
        let b = blurred[index * 3 + 2];
        // round100_features.py uses a float64 matrix multiply followed by f32.
        let luminance =
            (f64::from(r) * 0.2880402 + f64::from(g) * 0.7118741 + f64::from(b) * 0.0000857)
                .max(3e-5) as f32;
        let log_y = libm::log2f(luminance);
        y.push(luminance);
        ln.push(log_y);
        features[index][0] = log_y;
        features[index][3] = libm::log2f(r.max(g).max(b).max(3e-5)) - log_y;
        let sum = (r + g + b).max(1e-5);
        features[index][23] = r / sum;
        features[index][24] = g / sum;
    }

    let mean = numpy_mean_f32(&ln);
    let quantiles = linear_quantiles(&ln);
    for feature in &mut features {
        feature[1] = mean;
        feature[2] = feature[0] - mean;
        for (offset, value) in quantiles.iter().enumerate() {
            feature[16 + offset] = (*value - f64::from(mean)) as f32;
        }
    }

    let mut reduced_planes: Vec<(usize, ReducedPlanes)> = Vec::new();
    for (level, sigma) in LOCAL_SIGMAS.into_iter().enumerate() {
        let (local_log, arithmetic) = if reductions[level] <= 1 {
            (
                gaussian_blur(
                    &ln,
                    width,
                    height,
                    1,
                    sigma as f64,
                    sigma * 4,
                    Border::Reflect,
                ),
                gaussian_blur(
                    &y,
                    width,
                    height,
                    1,
                    sigma as f64,
                    sigma * 4,
                    Border::Reflect,
                ),
            )
        } else {
            let factor = reductions[level];
            if !reduced_planes.iter().any(|(f, _)| *f == factor) {
                reduced_planes.push((factor, ReducedPlanes::new(&ln, &y, width, height, factor)));
            }
            let planes = &reduced_planes.iter().find(|(f, _)| *f == factor).unwrap().1;
            planes.blurred(sigma as f64, width, height)
        };
        let base = 4 + level * 3;
        for index in 0..pixels {
            let local = local_log[index];
            features[index][base] = ln[index] - local;
            features[index][base + 1] = local - mean;
            features[index][base + 2] = libm::log2f(arithmetic[index].max(3e-5)) - local;
        }
    }

    let rank = global_rank(&ln);
    for (feature, value) in features.iter_mut().zip(rank) {
        feature[25] = value;
    }
    features
}

const QUANTILES: [f64; 7] = [0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99];

/// `ln` and `y` area-averaged onto a grid `factor` times coarser (a
/// uniform grid over the same extent), for the large local levels.
struct ReducedPlanes {
    width: usize,
    height: usize,
    /// Interleaved `ln`, `y`.
    data: Vec<f32>,
}

impl ReducedPlanes {
    fn new(ln: &[f32], y: &[f32], width: usize, height: usize, factor: usize) -> Self {
        let small_width = ((width as f64 / factor as f64).round() as usize).max(1);
        let small_height = ((height as f64 / factor as f64).round() as usize).max(1);
        let packed: Vec<f32> = ln.iter().zip(y).flat_map(|(&l, &v)| [l, v, 0.0]).collect();
        let small = crate::resize::resample(
            &packed,
            width,
            height,
            small_width,
            small_height,
            crate::resize::Filter::Area,
        );
        Self {
            width: small_width,
            height: small_height,
            data: small.chunks_exact(3).flat_map(|p| [p[0], p[1]]).collect(),
        }
    }

    /// The Gaussian blur of σ (analysis pixels) of both planes, on the
    /// coarse grid (σ and the 4σ radius in its own spacing per axis, the
    /// frozen reflect border at the same edges), then bilinear at each
    /// analysis pixel's center.
    fn blurred(&self, sigma: f64, width: usize, height: usize) -> (Vec<f32>, Vec<f32>) {
        let step_x = width as f64 / self.width as f64;
        let step_y = height as f64 / self.height as f64;
        let axis = |step: f64| {
            let sigma = sigma / step;
            (sigma, (sigma * 4.0).ceil() as usize)
        };
        let small = gaussian_blur_axes(
            &self.data,
            self.width,
            self.height,
            2,
            axis(step_x),
            axis(step_y),
            Border::Reflect,
        );
        let taps = |size: usize, small_size: usize, step: f64| -> Vec<(usize, usize, f32)> {
            (0..size)
                .map(|i| {
                    let u = ((i as f64 + 0.5) / step - 0.5).clamp(0.0, (small_size - 1) as f64);
                    let lower = u.floor() as usize;
                    let upper = (lower + 1).min(small_size - 1);
                    (lower, upper, (u - lower as f64) as f32)
                })
                .collect()
        };
        let columns = taps(width, self.width, step_x);
        let rows = taps(height, self.height, step_y);
        let mut local_log = Vec::with_capacity(width * height);
        let mut arithmetic = Vec::with_capacity(width * height);
        let row_len = self.width * 2;
        for &(top, bottom, fy) in &rows {
            let (a, b) = (&small[top * row_len..], &small[bottom * row_len..]);
            for &(left, right, fx) in &columns {
                for (channel, out) in [&mut local_log, &mut arithmetic].into_iter().enumerate() {
                    let upper = a[left * 2 + channel]
                        + (a[right * 2 + channel] - a[left * 2 + channel]) * fx;
                    let lower = b[left * 2 + channel]
                        + (b[right * 2 + channel] - b[left * 2 + channel]) * fx;
                    out.push(upper + (lower - upper) * fy);
                }
            }
        }
        (local_log, arithmetic)
    }
}

/// NumPy's linear quantiles of `values`. Only the order statistics they
/// read are selected (each among the values after the previous one), which
/// are the values a full sort puts there: `f32::total_cmp` orders bit
/// patterns.
fn linear_quantiles(values: &[f32]) -> [f64; 7] {
    let mut ordered = values.to_vec();
    let last = ordered.len() - 1;
    let mut ranks: Vec<usize> = QUANTILES
        .iter()
        .flat_map(|quantile| {
            let position = last as f64 * quantile;
            [position.floor() as usize, position.ceil() as usize]
        })
        .collect();
    ranks.sort_unstable();
    ranks.dedup();
    let mut start = 0;
    for rank in ranks {
        ordered[start..].select_nth_unstable_by(rank - start, f32::total_cmp);
        start = rank + 1;
    }
    QUANTILES.map(|quantile| {
        let position = last as f64 * quantile;
        let lower = position.floor() as usize;
        let upper = position.ceil() as usize;
        let fraction = position - lower as f64;
        f64::from(ordered[lower]) * (1.0 - fraction) + f64::from(ordered[upper]) * fraction
    })
}

#[cfg(test)]
fn linear_quantiles_sorted(values: &[f32]) -> [f64; 7] {
    let mut sorted = values.to_vec();
    sorted.sort_unstable_by(f32::total_cmp);
    let last = sorted.len() - 1;
    QUANTILES.map(|quantile| {
        let position = last as f64 * quantile;
        let lower = position.floor() as usize;
        let upper = position.ceil() as usize;
        let fraction = position - lower as f64;
        f64::from(sorted[lower]) * (1.0 - fraction) + f64::from(sorted[upper]) * fraction
    })
}

// NumPy's float32 reduction uses recursive pairwise summation with a 128-item
// block and eight accumulators.  Matching it keeps global features stable.
fn numpy_mean_f32(values: &[f32]) -> f32 {
    numpy_pairwise_sum(values) / values.len() as f32
}

fn numpy_pairwise_sum(values: &[f32]) -> f32 {
    const BLOCK: usize = 128;
    match values.len() {
        0 => 0.0,
        1..=7 => values
            .iter()
            .copied()
            .fold(-0.0_f32, |sum, value| sum + value),
        n if n <= BLOCK => {
            let mut sums = [
                values[0], values[1], values[2], values[3], values[4], values[5], values[6],
                values[7],
            ];
            let mut index = 8;
            while index + 8 <= n {
                for lane in 0..8 {
                    sums[lane] += values[index + lane];
                }
                index += 8;
            }
            let mut total = (sums[0] + sums[1])
                + (sums[2] + sums[3])
                + (sums[4] + sums[5])
                + (sums[6] + sums[7]);
            while index < n {
                total += values[index];
                index += 1;
            }
            total
        }
        n => {
            let mut midpoint = n / 2;
            midpoint -= midpoint % 8;
            numpy_pairwise_sum(&values[..midpoint]) + numpy_pairwise_sum(&values[midpoint..])
        }
    }
}

fn global_rank(ln: &[f32]) -> Vec<f32> {
    const BINS: usize = 256;
    const LOW: f32 = -16.0;
    const HIGH: f32 = 4.0;
    const STEP: f32 = (HIGH - LOW) / BINS as f32;
    let mut histogram = [0_usize; BINS];
    for &value in ln {
        if (LOW..=HIGH).contains(&value) {
            let bin = if value == HIGH {
                BINS - 1
            } else {
                (((value - LOW) / (HIGH - LOW)) * BINS as f32) as usize
            };
            histogram[bin.min(BINS - 1)] += 1;
        }
    }
    let denominator = ln.len() as f64;
    let mut cumulative = [0.0_f64; BINS];
    let mut count = 0_usize;
    for (index, frequency) in histogram.into_iter().enumerate() {
        count += frequency;
        cumulative[index] = count as f64 / denominator;
    }

    ln.iter()
        .map(|&value| {
            let first_edge = LOW + STEP;
            if value <= first_edge {
                return cumulative[0] as f32;
            }
            if value >= HIGH {
                return cumulative[BINS - 1] as f32;
            }
            let interval = ((value - first_edge) / STEP).floor() as usize;
            let left_edge = first_edge + interval as f32 * STEP;
            let fraction = f64::from((value - left_edge) / STEP);
            (cumulative[interval] * (1.0 - fraction) + cumulative[interval + 1] * fraction) as f32
        })
        .collect()
}

#[derive(Clone, Copy)]
enum Border {
    Reflect,
    Reflect101,
}

use crate::raw_response_simd as simd;

// Preserve each output's tap order. Padding makes horizontal loads contiguous;
// 32 (then 16) independent accumulators let native and Wasm SIMD share exactly the same
// multiply-then-add arithmetic, without an approximate blur or fused operations.
fn gaussian_blur(
    source: &[f32],
    width: usize,
    height: usize,
    channels: usize,
    sigma: f64,
    radius: usize,
    border: Border,
) -> Vec<f32> {
    gaussian_blur_axes(
        source,
        width,
        height,
        channels,
        (sigma, radius),
        (sigma, radius),
        border,
    )
}

/// [`gaussian_blur`] with its own σ and radius per axis.
fn gaussian_blur_axes(
    source: &[f32],
    width: usize,
    height: usize,
    channels: usize,
    (sigma, radius): (f64, usize),
    (sigma_y, radius_y): (f64, usize),
    border: Border,
) -> Vec<f32> {
    let kernel = gaussian_kernel(sigma, radius);
    let row_len = width * channels;
    let padded_width = width + 2 * radius;
    let x_indices: Vec<_> = (0..padded_width)
        .map(|x| border_index(x as isize - radius as isize, width, border))
        .collect();
    let starts: Vec<_> = (0..kernel.len()).map(|tap| tap * channels).collect();
    let mut padded = vec![0.0_f32; padded_width * channels];
    let mut horizontal = vec![0.0_f32; source.len()];
    let mut output = vec![0.0_f32; source.len()];
    for y in 0..height {
        for (x, &source_x) in x_indices.iter().enumerate() {
            padded[x * channels..(x + 1) * channels].copy_from_slice(
                &source[y * row_len + source_x * channels..y * row_len + (source_x + 1) * channels],
            );
        }
        simd::convolve_row(
            &padded,
            &starts,
            &kernel,
            &mut horizontal[y * row_len..(y + 1) * row_len],
        );
    }
    let kernel = if (sigma_y, radius_y) == (sigma, radius) {
        kernel
    } else {
        gaussian_kernel(sigma_y, radius_y)
    };
    let mut starts = vec![0_usize; kernel.len()];
    for y in 0..height {
        for (tap, start) in starts.iter_mut().enumerate() {
            *start = border_index(
                y as isize + tap as isize - radius_y as isize,
                height,
                border,
            ) * row_len;
        }
        simd::convolve_row(
            &horizontal,
            &starts,
            &kernel,
            &mut output[y * row_len..(y + 1) * row_len],
        );
    }
    output
}

#[cfg(test)]
fn gaussian_blur_reference(
    source: &[f32],
    width: usize,
    height: usize,
    channels: usize,
    sigma: f64,
    radius: usize,
    border: Border,
) -> Vec<f32> {
    let kernel = gaussian_kernel(sigma, radius);
    let x_indices = convolution_indices(width, radius, border);
    let y_indices = convolution_indices(height, radius, border);
    let mut horizontal = vec![0.0_f32; source.len()];
    let mut output = vec![0.0_f32; source.len()];
    let kernel_len = kernel.len();

    for y in 0..height {
        for x in 0..width {
            for channel in 0..channels {
                let mut sum = 0.0_f32;
                let index_base = x * kernel_len;
                for tap in 0..kernel_len {
                    let source_x = x_indices[index_base + tap];
                    sum += source[(y * width + source_x) * channels + channel] * kernel[tap];
                }
                horizontal[(y * width + x) * channels + channel] = sum;
            }
        }
    }
    for y in 0..height {
        let index_base = y * kernel_len;
        for x in 0..width {
            for channel in 0..channels {
                let mut sum = 0.0_f32;
                for tap in 0..kernel_len {
                    let source_y = y_indices[index_base + tap];
                    sum += horizontal[(source_y * width + x) * channels + channel] * kernel[tap];
                }
                output[(y * width + x) * channels + channel] = sum;
            }
        }
    }
    output
}

fn gaussian_kernel(sigma: f64, radius: usize) -> Vec<f32> {
    let mut kernel: Vec<f64> = (0..=radius * 2)
        .map(|index| {
            let x = index as f64 - radius as f64;
            libm::exp(-(x * x) / (2.0 * sigma * sigma))
        })
        .collect();
    let sum: f64 = kernel.iter().sum();
    kernel.iter_mut().for_each(|value| *value /= sum);
    kernel.into_iter().map(|value| value as f32).collect()
}

#[cfg(test)]
fn convolution_indices(length: usize, radius: usize, border: Border) -> Vec<usize> {
    let mut indices = Vec::with_capacity(length * (radius * 2 + 1));
    for output in 0..length {
        for tap in 0..=radius * 2 {
            let position = output as isize + tap as isize - radius as isize;
            indices.push(border_index(position, length, border));
        }
    }
    indices
}

fn border_index(position: isize, length: usize, border: Border) -> usize {
    if length == 1 {
        return 0;
    }
    let n = length as isize;
    match border {
        Border::Reflect => {
            let period = 2 * n;
            let wrapped = position.rem_euclid(period);
            if wrapped < n {
                wrapped as usize
            } else {
                (period - 1 - wrapped) as usize
            }
        }
        Border::Reflect101 => {
            let period = 2 * (n - 1);
            let wrapped = position.rem_euclid(period);
            if wrapped < n {
                wrapped as usize
            } else {
                (period - wrapped) as usize
            }
        }
    }
}

struct Model {
    weights: Vec<f64>,
    mean: [f64; FEATURE_COUNT],
    scale: [f64; FEATURE_COUNT],
}

impl Model {
    fn infer(&self, feature: &[f32; FEATURE_COUNT]) -> [f64; 2] {
        let mut normalized = [0.0_f64; FEATURE_COUNT];
        for index in 0..FEATURE_COUNT {
            normalized[index] = ((f64::from(feature[index]) - self.mean[index])
                / self.scale[index])
                .clamp(-6.0, 6.0);
        }

        // Each output keeps its original input accumulation order. Moving
        // independent outputs next to one another lets SIMD process them
        // together without a reduction, FMA, or approximate activation.
        let mut hidden1 = [0.0_f64; 24];
        hidden1.copy_from_slice(&self.weights[624..648]);
        for (input, value_in) in normalized.iter().enumerate() {
            let weights = &self.weights[input * 24..(input + 1) * 24];
            for (value, weight) in hidden1.iter_mut().zip(weights) {
                *value += value_in * weight;
            }
        }
        hidden1
            .iter_mut()
            .for_each(|value| *value = libm::tanh(*value));
        let mut hidden2 = [0.0_f64; 16];
        hidden2.copy_from_slice(&self.weights[1032..1048]);
        for (input, value_in) in hidden1.iter().enumerate() {
            let weights = &self.weights[648 + input * 16..648 + (input + 1) * 16];
            for (value, weight) in hidden2.iter_mut().zip(weights) {
                *value += value_in * weight;
            }
        }
        hidden2
            .iter_mut()
            .for_each(|value| *value = libm::tanh(*value));
        let mut result = [0.0_f64; 2];
        for (output, activation) in result.iter_mut().enumerate() {
            let mut value = self.weights[1080 + output];
            for (input, value_in) in hidden2.iter().enumerate() {
                value += value_in * self.weights[1048 + input * 2 + output];
            }
            *activation = softplus(value);
        }
        result
    }

    #[cfg(test)]
    fn infer_scalar_reference(&self, feature: &[f32; FEATURE_COUNT]) -> [f64; 2] {
        let mut normalized = [0.0_f64; FEATURE_COUNT];
        for index in 0..FEATURE_COUNT {
            normalized[index] = ((f64::from(feature[index]) - self.mean[index])
                / self.scale[index])
                .clamp(-6.0, 6.0);
        }

        let mut hidden1 = [0.0_f64; 24];
        for (output, activation) in hidden1.iter_mut().enumerate() {
            let mut value = self.weights[624 + output];
            for (input, value_in) in normalized.iter().enumerate() {
                value += value_in * self.weights[input * 24 + output];
            }
            *activation = libm::tanh(value);
        }
        let mut hidden2 = [0.0_f64; 16];
        for (output, activation) in hidden2.iter_mut().enumerate() {
            let mut value = self.weights[1032 + output];
            for (input, value_in) in hidden1.iter().enumerate() {
                value += value_in * self.weights[648 + input * 16 + output];
            }
            *activation = libm::tanh(value);
        }
        let mut result = [0.0_f64; 2];
        for (output, activation) in result.iter_mut().enumerate() {
            let mut value = self.weights[1080 + output];
            for (input, value_in) in hidden2.iter().enumerate() {
                value += value_in * self.weights[1048 + input * 2 + output];
            }
            *activation = softplus(value);
        }
        result
    }
}

fn softplus(value: f64) -> f64 {
    value.max(0.0) + libm::log1p(libm::exp(-value.abs()))
}

static MODELS: OnceLock<Result<(Model, Model), String>> = OnceLock::new();

fn models() -> Result<&'static (Model, Model), RawResponseError> {
    MODELS
        .get_or_init(parse_models)
        .as_ref()
        .map_err(|message| RawResponseError::EmbeddedModel(message.clone()))
}

fn parse_models() -> Result<(Model, Model), String> {
    let root: Value = serde_json::from_str(MODEL_JSON).map_err(|error| error.to_string())?;
    expect_string(&root, "schema", MODEL_SCHEMA)?;
    expect_string(&root, "featureSourceSha256", FEATURE_SOURCE_SHA256)?;
    validate_layout(root.get("layout").ok_or("missing layout")?)?;
    let highlight = parse_model(
        root.get("highlight").ok_or("missing highlight model")?,
        HIGHLIGHT_MODEL_SHA256,
    )?;
    let shadow = parse_model(
        root.get("shadow").ok_or("missing shadow model")?,
        SHADOW_MODEL_SHA256,
    )?;
    Ok((highlight, shadow))
}

fn expect_string(root: &Value, key: &str, expected: &str) -> Result<(), String> {
    let actual = root
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing or invalid {key}"))?;
    if actual != expected {
        return Err(format!("{key} mismatch"));
    }
    Ok(())
}

fn validate_layout(value: &Value) -> Result<(), String> {
    let layers = value.as_array().ok_or("layout is not an array")?;
    if layers.len() != MODEL_LAYOUT.len() {
        return Err("layout layer count mismatch".into());
    }
    for (index, (layer, expected)) in layers.iter().zip(MODEL_LAYOUT).enumerate() {
        let dimensions = layer
            .as_array()
            .ok_or_else(|| format!("layout layer {index} is not an array"))?;
        let expected_dimensions: &[usize] = if expected[1] == 1 {
            &expected[..1]
        } else {
            &expected
        };
        if dimensions.len() != expected_dimensions.len()
            || dimensions
                .iter()
                .zip(expected_dimensions)
                .any(|(actual, expected)| actual.as_u64() != Some(*expected as u64))
        {
            return Err(format!("layout layer {index} mismatch"));
        }
    }
    Ok(())
}

fn parse_model(value: &Value, expected_sha: &str) -> Result<Model, String> {
    expect_string(value, "sourceSha256", expected_sha)?;
    let weights = parse_finite_array(value, "weights", WEIGHT_COUNT)?;
    let mean: [f64; FEATURE_COUNT] = parse_finite_array(value, "mean", FEATURE_COUNT)?
        .try_into()
        .map_err(|_| "mean length mismatch".to_string())?;
    let scale: [f64; FEATURE_COUNT] = parse_finite_array(value, "scale", FEATURE_COUNT)?
        .try_into()
        .map_err(|_| "scale length mismatch".to_string())?;
    if scale.iter().any(|value| *value <= 0.0) {
        return Err("model scale must be positive".into());
    }
    Ok(Model {
        weights,
        mean,
        scale,
    })
}

fn parse_finite_array(root: &Value, key: &str, expected: usize) -> Result<Vec<f64>, String> {
    let values = root
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("missing or invalid {key}"))?;
    if values.len() != expected {
        return Err(format!("{key} length mismatch"));
    }
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let value = value
                .as_f64()
                .ok_or_else(|| format!("{key}[{index}] is not a number"))?;
            if !value.is_finite() {
                return Err(format!("{key}[{index}] is non-finite"));
            }
            Ok(value)
        })
        .collect()
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn border_modes_match_their_definitions() {
        let reflect: Vec<_> = (-5..=8)
            .map(|index| border_index(index, 4, Border::Reflect))
            .collect();
        assert_eq!(reflect, [3, 3, 2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0, 0]);
        let reflect101: Vec<_> = (-5..=8)
            .map(|index| border_index(index, 4, Border::Reflect101))
            .collect();
        assert_eq!(reflect101, [1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2]);
    }

    #[test]
    fn vector_blur_preserves_tap_order_and_borders() {
        // Rows of 32-wide blocks, a 16-wide block and the scalar rest.
        for (width, height, channels) in [
            (1, 1, 1),
            (1, 19, 3),
            (21, 1, 1),
            (17, 13, 3),
            (37, 23, 1),
            (53, 9, 1),
            (29, 7, 3),
        ] {
            let source: Vec<f32> = (0..width * height * channels)
                .map(|i| (i * 7919 % 10007) as f32 / 1000.0 - 5.0)
                .collect();
            for (sigma, radius) in [(1.0, 4), (4.0, 16), (16.0, 64), (64.0, 256), (128.0, 512)] {
                for border in [Border::Reflect, Border::Reflect101] {
                    let expected = gaussian_blur_reference(
                        &source, width, height, channels, sigma, radius, border,
                    );
                    let actual =
                        gaussian_blur(&source, width, height, channels, sigma, radius, border);
                    assert!(
                        actual
                            .iter()
                            .zip(&expected)
                            .all(|(a, b)| a.to_bits() == b.to_bits()),
                        "{width}x{height} channels={channels} sigma={sigma}"
                    );
                }
            }
        }
    }

    #[test]
    fn selected_quantiles_are_those_of_the_sorted_values() {
        let mut state = 0x2545_f491u32;
        for length in [1usize, 2, 3, 7, 10, 101, 1000, 4097] {
            for ties in [false, true] {
                let values: Vec<f32> = (0..length)
                    .map(|_| {
                        state ^= state << 13;
                        state ^= state >> 17;
                        state ^= state << 5;
                        if ties {
                            [-0.0, 0.0, 1.5, -3.25][(state % 4) as usize]
                        } else {
                            (state as f64 / u32::MAX as f64 * 20.0 - 16.0) as f32
                        }
                    })
                    .collect();
                let selected = linear_quantiles(&values);
                let sorted = linear_quantiles_sorted(&values);
                assert!(
                    selected
                        .iter()
                        .zip(&sorted)
                        .all(|(a, b)| a.to_bits() == b.to_bits()),
                    "{length} {ties}: {selected:?} {sorted:?}"
                );
            }
        }
    }

    #[test]
    fn independent_model_outputs_match_frozen_scalar_accumulation() {
        let (highlight, shadow) = models().unwrap();
        let mut state = 0x715e_3081u32;
        for model in [highlight, shadow] {
            for sample in 0..2048 {
                let mut feature = [0.0; FEATURE_COUNT];
                for value in &mut feature {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    *value = match sample % 4 {
                        0 => (state as f64 / u32::MAX as f64 * 16.0 - 8.0) as f32,
                        1 => f32::from_bits(state & 0x7f7f_ffff),
                        2 => -f32::from_bits(state & 0x7f7f_ffff),
                        _ => 0.0,
                    };
                }
                let expected = model.infer_scalar_reference(&feature).map(f64::to_bits);
                assert_eq!(model.infer(&feature).map(f64::to_bits), expected);
            }
        }
    }

    #[test]
    fn embedded_models_have_frozen_layout_and_sources() {
        let (highlight, shadow) = models().unwrap();
        assert_eq!(highlight.weights.len(), WEIGHT_COUNT);
        assert_eq!(shadow.weights.len(), WEIGHT_COUNT);
    }
}
