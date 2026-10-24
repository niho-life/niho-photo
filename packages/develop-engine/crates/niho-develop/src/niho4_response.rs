//! NIHO 4 camera-scoped highlight/shadow response frozen by R395.
//!
//! The input is an area-resized canonical analysis image (long edge 750),
//! after baseline exposure, in linear ProPhoto RGB.  Resize, white balance,
//! exposure, and render-pipeline integration intentionally live outside this
//! module.  The embedded coefficients are a representation-only export.
//! R393 is used for Panasonic DC-S5. R364 is used for Sony ZV-E10M2 and
//! ILME-FX30. The model assets are representation-only exports; no fitting
//! or threshold selection happens in this crate.

use serde_json::Value;
use std::fmt;
use std::sync::OnceLock;

pub const FEATURE_COUNT: usize = 26;
const WEIGHT_COUNT: usize = 1082;
const SONY_HIGHLIGHT_WEIGHT_COUNT: usize = 1099;
const PANASONIC_MODEL_JSON: &str = include_str!("../niho4/response-panasonic-r393.json");
const SONY_MODEL_JSON: &str = include_str!("../niho4/response-sony-r364.json");
const PANASONIC_MODEL_SCHEMA: &str = "niho.raw-response-models.private-two-response.v1";
const SONY_MODEL_SCHEMA: &str = "niho.raw-response-models.private-two-response.v1";
const MODEL_LAYOUT: [[usize; 2]; 6] = [[26, 24], [24, 1], [24, 16], [16, 1], [16, 2], [2, 1]];
const PANASONIC_HS_INTERACTION: f32 = 0.45;

/// SHA-256 of the frozen feature implementation used to define this port.
pub const FEATURE_SOURCE_SHA256: &str =
    "32ffd22017f6d42155fc6826c2f9def0cfcffd895b8a1a89d841d5b87f88277a";
/// SHA-256 of the R393 Panasonic highlight/chroma NPZ.
pub const PANASONIC_HIGHLIGHT_MODEL_SHA256: &str =
    "bb1f49e0581bdce01fd577e5736fc2ed9d5b6aaff3a59a4e4aa592569ff95b73";
/// SHA-256 of the R364/R363 Sony highlight NPZ.
pub const SONY_HIGHLIGHT_MODEL_SHA256: &str =
    "837b0b40282e5ce06dd9c98d38315d64d3daabf5e475c9fc0733aa1af5851aa3";
/// SHA-256 of the unchanged R245 shadow NPZ.
pub const SHADOW_MODEL_SHA256: &str =
    "ae84b10056b77f189ed383392f1f6b972243caad865ec11a2bd81b7d91b07c5f";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Camera {
    PanasonicDcS5,
    SonyZvE10m2,
    SonyIlmeFx30,
}

impl Camera {
    /// Resolves only the frozen Apple signed-RAW calibration family. Unknown,
    /// uncalibrated and lookalike values are intentionally unsupported.
    pub fn from_calibration(value: &str) -> Option<Self> {
        const PREFIX: &str = "apple-ciraw8/linear-prophoto-d50/cal-";
        let suffix = value.strip_prefix(PREFIX)?;
        let (camera, version) = suffix.rsplit_once("-apple-v")?;
        if version.is_empty() || !version.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        match camera {
            "panasonic-dc-s5" => Some(Self::PanasonicDcS5),
            "sony-zv-e10m2" => Some(Self::SonyZvE10m2),
            "sony-ilme-fx30" => Some(Self::SonyIlmeFx30),
            _ => None,
        }
    }
}

/// Camera-wide H/S interaction fixed before the R385 independent evaluation.
/// H-only and S-only responses are unchanged; Sony retains its R364 behavior.
pub fn shadow_interaction_scale(camera: Camera, highlights: f32, shadows: f32) -> f32 {
    if camera != Camera::PanasonicDcS5 {
        return 1.0;
    }
    let h = (-highlights.min(0.0) / 100.0).clamp(0.0, 1.0);
    let s = (shadows.max(0.0) / 100.0).clamp(0.0, 1.0);
    1.0 - PANASONIC_HS_INTERACTION * h.powi(4) * s
}

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
    pub camera: Camera,
    pub width: usize,
    pub height: usize,
    pub highlight_a: Vec<f32>,
    pub highlight_b: Vec<f32>,
    pub highlight_alpha: Vec<f32>,
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
    camera: Camera,
    linear_prophoto_rgb: &[f32],
    width: usize,
    height: usize,
) -> Result<CoefficientMaps, RawResponseError> {
    let pixels = validate_input(linear_prophoto_rgb, width, height)?;
    let features = extract_features(linear_prophoto_rgb, width, height);
    validate_features(&features)?;
    let (highlight_model, shadow_model) = models(camera)?;
    let highlight_fixed = highlight_model.fixed_feature_products(&features[0]);
    let shadow_fixed = shadow_model.fixed_feature_products(&features[0]);

    let mut highlight_a = Vec::with_capacity(pixels);
    let mut highlight_b = Vec::with_capacity(pixels);
    let mut highlight_alpha = Vec::with_capacity(pixels);
    let mut shadow_a = Vec::with_capacity(pixels);
    let mut shadow_b = Vec::with_capacity(pixels);
    for feature in &features {
        let [ha, hb, alpha] = highlight_model.infer_with_fixed(feature, &highlight_fixed);
        let [sa, sb, _] = shadow_model.infer_with_fixed(feature, &shadow_fixed);
        highlight_a.push(ha as f32);
        highlight_b.push(hb as f32);
        highlight_alpha.push(alpha as f32);
        shadow_a.push(sa as f32);
        shadow_b.push(sb as f32);
    }
    Ok(CoefficientMaps {
        camera,
        width,
        height,
        highlight_a,
        highlight_b,
        highlight_alpha,
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

    if coefficients.highlight_alpha.len() != pixels {
        return Err(RawResponseError::InvalidInputLength {
            expected: pixels,
            actual: coefficients.highlight_alpha.len(),
        });
    }
    if let Some(index) = coefficients
        .highlight_alpha
        .iter()
        .position(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
    {
        return Err(RawResponseError::InvalidCoefficient {
            map: "highlight_alpha",
            index,
        });
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
    let interaction = shadow_interaction_scale(coefficients.camera, highlights, shadows);
    let (highlights, shadows) = gain_ev_components(coefficients, highlights, shadows)?;
    Ok(highlights
        .into_iter()
        .zip(shadows)
        .map(|(highlight, shadow)| highlight + shadow * interaction)
        .collect())
}

/// Computes coefficient maps and their combined gain in one call.
pub fn evaluate(
    camera: Camera,
    linear_prophoto_rgb: &[f32],
    width: usize,
    height: usize,
    highlights: f32,
    shadows: f32,
) -> Result<RawResponse, RawResponseError> {
    validate_amounts(highlights, shadows)?;
    let coefficients = coefficient_maps(camera, linear_prophoto_rgb, width, height)?;
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

    for (level, sigma) in [4_usize, 16, 64, 128].into_iter().enumerate() {
        let local_log = gaussian_blur(
            &ln,
            width,
            height,
            1,
            sigma as f64,
            sigma * 4,
            Border::Reflect,
        );
        let arithmetic = gaussian_blur(
            &y,
            width,
            height,
            1,
            sigma as f64,
            sigma * 4,
            Border::Reflect,
        );
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

fn linear_quantiles(values: &[f32]) -> [f64; 7] {
    const QUANTILES: [f64; 7] = [0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99];
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
    let mut starts = vec![0_usize; kernel.len()];
    for y in 0..height {
        for (tap, start) in starts.iter_mut().enumerate() {
            *start =
                border_index(y as isize + tap as isize - radius as isize, height, border) * row_len;
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
    output_count: usize,
    weights: Vec<f64>,
    mean: [f64; FEATURE_COUNT],
    scale: [f64; FEATURE_COUNT],
}

// The image mean and seven quantiles are identical for every pixel. Keep
// their first-layer products, then add them in the original input order so
// floating-point rounding and the frozen model's output remain unchanged.
struct FixedFeatureProducts {
    hidden1: [[f64; 24]; 8],
}

fn fixed_feature_slot(index: usize) -> Option<usize> {
    match index {
        1 => Some(0),
        16..=22 => Some(index - 15),
        _ => None,
    }
}

impl Model {
    fn fixed_feature_products(&self, feature: &[f32; FEATURE_COUNT]) -> FixedFeatureProducts {
        let mut hidden1 = [[0.0; 24]; 8];
        for (slot, index) in [1, 16, 17, 18, 19, 20, 21, 22].into_iter().enumerate() {
            let normalized = ((f64::from(feature[index]) - self.mean[index]) / self.scale[index])
                .clamp(-6.0, 6.0);
            for (output, product) in hidden1[slot].iter_mut().enumerate() {
                *product = normalized * self.weights[index * 24 + output];
            }
        }
        FixedFeatureProducts { hidden1 }
    }

    fn infer_with_fixed(
        &self,
        feature: &[f32; FEATURE_COUNT],
        fixed: &FixedFeatureProducts,
    ) -> [f64; 3] {
        let mut normalized = [0.0_f64; FEATURE_COUNT];
        for index in 0..FEATURE_COUNT {
            if fixed_feature_slot(index).is_none() {
                normalized[index] = ((f64::from(feature[index]) - self.mean[index])
                    / self.scale[index])
                    .clamp(-6.0, 6.0);
            }
        }

        let mut hidden1 = [0.0_f64; 24];
        hidden1.copy_from_slice(&self.weights[624..648]);
        for (input, value_in) in normalized.iter().enumerate() {
            if let Some(slot) = fixed_feature_slot(input) {
                for (value, product) in hidden1.iter_mut().zip(&fixed.hidden1[slot]) {
                    *value += product;
                }
            } else {
                let weights = &self.weights[input * 24..(input + 1) * 24];
                for (value, weight) in hidden1.iter_mut().zip(weights) {
                    *value += value_in * weight;
                }
            }
        }
        self.finish_hidden1(hidden1)
    }

    fn infer(&self, feature: &[f32; FEATURE_COUNT]) -> [f64; 3] {
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
        self.finish_hidden1(hidden1)
    }

    #[inline(always)]
    fn finish_hidden1(&self, mut hidden1: [f64; 24]) -> [f64; 3] {
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
        let mut result = [0.0_f64, 0.0, 1.0];
        for (output, activation) in result.iter_mut().enumerate().take(self.output_count) {
            let mut value = self.weights[1048 + 16 * self.output_count + output];
            for (input, value_in) in hidden2.iter().enumerate() {
                value += value_in * self.weights[1048 + input * self.output_count + output];
            }
            *activation = if output == 2 {
                1.0 / (1.0 + libm::exp(-value))
            } else {
                softplus(value)
            };
        }
        result
    }

    #[cfg(test)]
    fn infer_scalar_reference(&self, feature: &[f32; FEATURE_COUNT]) -> [f64; 3] {
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
        let mut result = [0.0_f64, 0.0, 1.0];
        for (output, activation) in result.iter_mut().enumerate().take(self.output_count) {
            let mut value = self.weights[1048 + 16 * self.output_count + output];
            for (input, value_in) in hidden2.iter().enumerate() {
                value += value_in * self.weights[1048 + input * self.output_count + output];
            }
            *activation = if output == 2 {
                1.0 / (1.0 + libm::exp(-value))
            } else {
                softplus(value)
            };
        }
        result
    }
}

fn softplus(value: f64) -> f64 {
    value.max(0.0) + libm::log1p(libm::exp(-value.abs()))
}

static PANASONIC_MODELS: OnceLock<Result<(Model, Model), String>> = OnceLock::new();
static SONY_MODELS: OnceLock<Result<(Model, Model), String>> = OnceLock::new();

fn models(camera: Camera) -> Result<&'static (Model, Model), RawResponseError> {
    let models = match camera {
        Camera::PanasonicDcS5 => PANASONIC_MODELS.get_or_init(parse_panasonic_models),
        Camera::SonyZvE10m2 | Camera::SonyIlmeFx30 => SONY_MODELS.get_or_init(parse_sony_models),
    };
    models
        .as_ref()
        .map_err(|message| RawResponseError::EmbeddedModel(message.clone()))
}

fn parse_panasonic_models() -> Result<(Model, Model), String> {
    let root: Value =
        serde_json::from_str(PANASONIC_MODEL_JSON).map_err(|error| error.to_string())?;
    expect_string(&root, "schema", PANASONIC_MODEL_SCHEMA)?;
    expect_string(&root, "featureSourceSha256", FEATURE_SOURCE_SHA256)?;
    validate_layout(root.get("shadowLayout").ok_or("missing shadow layout")?, 2)?;
    validate_layout(
        root.get("highlightLayout")
            .ok_or("missing highlight layout")?,
        3,
    )?;
    let highlight = parse_model(
        root.get("highlight").ok_or("missing highlight model")?,
        PANASONIC_HIGHLIGHT_MODEL_SHA256,
        3,
    )?;
    let shadow = parse_model(
        root.get("shadow").ok_or("missing shadow model")?,
        SHADOW_MODEL_SHA256,
        2,
    )?;
    Ok((highlight, shadow))
}

fn parse_sony_models() -> Result<(Model, Model), String> {
    let root: Value = serde_json::from_str(SONY_MODEL_JSON).map_err(|error| error.to_string())?;
    expect_string(&root, "schema", SONY_MODEL_SCHEMA)?;
    expect_string(&root, "featureSourceSha256", FEATURE_SOURCE_SHA256)?;
    validate_layout(root.get("shadowLayout").ok_or("missing shadow layout")?, 2)?;
    validate_layout(
        root.get("highlightLayout")
            .ok_or("missing highlight layout")?,
        3,
    )?;
    let highlight = parse_model(
        root.get("highlight").ok_or("missing highlight model")?,
        SONY_HIGHLIGHT_MODEL_SHA256,
        3,
    )?;
    let shadow = parse_model(
        root.get("shadow").ok_or("missing shadow model")?,
        SHADOW_MODEL_SHA256,
        2,
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

fn validate_layout(value: &Value, outputs: usize) -> Result<(), String> {
    let mut layout = MODEL_LAYOUT;
    layout[4] = [16, outputs];
    layout[5] = [outputs, 1];
    let layers = value.as_array().ok_or("layout is not an array")?;
    if layers.len() != MODEL_LAYOUT.len() {
        return Err("layout layer count mismatch".into());
    }
    for (index, (layer, expected)) in layers.iter().zip(layout).enumerate() {
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

fn parse_model(value: &Value, expected_sha: &str, output_count: usize) -> Result<Model, String> {
    expect_string(value, "sourceSha256", expected_sha)?;
    let weights = parse_finite_array(
        value,
        "weights",
        if output_count == 3 {
            SONY_HIGHLIGHT_WEIGHT_COUNT
        } else {
            WEIGHT_COUNT
        },
    )?;
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
        output_count,
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
        for (width, height, channels) in
            [(1, 1, 1), (1, 19, 3), (21, 1, 1), (17, 13, 3), (37, 23, 1)]
        {
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
    fn independent_model_outputs_match_frozen_scalar_accumulation() {
        let mut state = 0x715e_3081u32;
        for camera in [Camera::PanasonicDcS5, Camera::SonyZvE10m2] {
            let (highlight, shadow) = models(camera).unwrap();
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
    }

    #[test]
    fn fixed_image_features_keep_model_outputs_bit_exact() {
        let mut state = 0x653f_1a29u32;
        for camera in [Camera::PanasonicDcS5, Camera::SonyZvE10m2] {
            let (highlight, shadow) = models(camera).unwrap();
            for model in [highlight, shadow] {
                let mut feature = [0.0; FEATURE_COUNT];
                for index in [1, 16, 17, 18, 19, 20, 21, 22] {
                    feature[index] = index as f32 / 7.0 - 2.0;
                }
                let fixed = model.fixed_feature_products(&feature);
                for sample in 0..1024 {
                    for (index, value) in feature.iter_mut().enumerate() {
                        if fixed_feature_slot(index).is_none() {
                            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                            *value = (state as f64 / u32::MAX as f64 * 16.0 - 8.0) as f32;
                        }
                    }
                    assert_eq!(
                        model.infer_with_fixed(&feature, &fixed).map(f64::to_bits),
                        model.infer(&feature).map(f64::to_bits),
                        "{camera:?} sample {sample}"
                    );
                }
            }
        }
    }

    #[test]
    fn embedded_models_have_frozen_layout_and_sources() {
        let (panasonic_h, panasonic_s) = models(Camera::PanasonicDcS5).unwrap();
        assert_eq!(panasonic_h.weights.len(), SONY_HIGHLIGHT_WEIGHT_COUNT);
        assert_eq!(panasonic_s.weights.len(), WEIGHT_COUNT);
        let (sony_h, sony_s) = models(Camera::SonyZvE10m2).unwrap();
        assert_eq!(sony_h.weights.len(), SONY_HIGHLIGHT_WEIGHT_COUNT);
        assert_eq!(sony_s.weights.len(), WEIGHT_COUNT);
    }
}

#[cfg(test)]
mod camera_contract {
    use super::*;

    #[test]
    fn alpha_contract_rejects_invalid_cache_values() {
        let mut c = coefficient_maps(Camera::SonyZvE10m2, &[0.3, 0.2, 0.1], 1, 1).unwrap();
        for v in [f32::NAN, f32::INFINITY, -0.001, 1.001] {
            c.highlight_alpha[0] = v;
            assert!(gain_ev_components(&c, -60.0, 30.0).is_err());
        }
        c.highlight_alpha.clear();
        assert!(gain_ev_components(&c, -60.0, 30.0).is_err());
    }

    #[test]
    fn dispatch_accepts_only_frozen_camera_calibration_families() {
        assert_eq!(
            Camera::from_calibration(
                "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4"
            ),
            Some(Camera::PanasonicDcS5)
        );
        assert_eq!(
            Camera::from_calibration("apple-ciraw8/linear-prophoto-d50/cal-sony-zv-e10m2-apple-v3"),
            Some(Camera::SonyZvE10m2)
        );
        assert_eq!(
            Camera::from_calibration(
                "apple-ciraw8/linear-prophoto-d50/cal-sony-ilme-fx30-apple-v2"
            ),
            Some(Camera::SonyIlmeFx30)
        );
        for unsupported in [
            "",
            "fixture",
            "apple-ciraw8/linear-prophoto-d50/uncalibrated",
            "apple-ciraw8/linear-prophoto-d50/cal-sony-a7m4-apple-v1",
            "apple-ciraw8/linear-prophoto-d50/cal-sony-zv-e10m2-apple-v",
            "prefix/apple-ciraw8/linear-prophoto-d50/cal-sony-zv-e10m2-apple-v3",
        ] {
            assert_eq!(Camera::from_calibration(unsupported), None, "{unsupported}");
        }
    }
}
