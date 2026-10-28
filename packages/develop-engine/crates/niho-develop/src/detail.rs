//! v6 detail processing on float linear-light pixels.
//!
//! Noise reduction runs on the source before adaptive/local processing.
//! Sharpening runs on the output-sized linear-sRGB plane immediately before
//! output transform and output effects. Radii are expressed at a 1500 px
//! whole-photo long edge; a geometry window therefore keeps the same source
//! scale as the uncropped frame.
//!
//! Every slider follows the meaning of Lightroom's Detail panel, and the few
//! coefficients in [`calibration`] were fitted to Lightroom's exports of a
//! 1500 x 1000 synthetic chart (Issue #32 round 32,
//! `fixtures/color/review-2026-10-21/detail-round32-*.json`,
//! `docs/detail-processing.md`):
//!
//! - Sharpening: an unsharp mask of linear-light luma that scales RGB to
//!   the new luma. Amount is the gain, Radius the Gaussian, Detail the halo
//!   allowance (low values hold the gain back, high values let texture and
//!   small edges through) and Masking a threshold on the local edge energy.
//!   Halos are soft-limited: light halos to a fixed linear step, dark halos
//!   also in proportion to the square of the local level so dark sides do
//!   not collapse to black.
//! - Luminance noise reduction: an edge-avoiding a-trous filter of
//!   `sqrt(luma)` (a gamma-2 domain, so the strength does not depend on
//!   brightness) whose range cut and blend grow with the amount; the change
//!   is added to every channel in the same square-root domain.
//! - Color noise reduction (raster sources): a small Gaussian of the chroma
//!   ratios `RGB / luma` that keeps every pixel's luma; it is full at 25 and
//!   the same up to 100 (Lightroom's 25 / 50 / 100 leave the same residual on
//!   pixel-level chroma noise). Signed RAW keeps the R209 contract.

use crate::color::{PP_LUMA_F32, REC709_LUMA_F32};
use crate::settings::{DetailSettings, SharpeningSettings};
use std::fmt;

/// Coefficients fitted to Lightroom (round 32). Lengths are pixels at the
/// 1500 px reference long edge; levels are linear light unless noted.
mod calibration {
    /// Gaussian sigma of the sharpening blur at Radius 1.0, and its power
    /// law in Radius (`sigma = SIGMA * radius ^ SIGMA_POWER`).
    pub const SHARP_SIGMA: f64 = 0.81;
    pub const SHARP_SIGMA_POWER: f64 = 0.785;
    /// USM gain at Amount 100 / Detail 25 / sigma 1, its power in
    /// Amount / 100 and in the sigma (wider blurs are gentler per pixel).
    pub const SHARP_GAIN: f64 = 2.9;
    pub const SHARP_AMOUNT_POWER: f64 = 1.2;
    pub const SHARP_GAIN_SIGMA_POWER: f64 = 1.22;
    /// Detail scales the gain by `(d ^ P + F) / (0.25 ^ P + F)` (1 at 25).
    pub const DETAIL_POWER: f64 = 0.785;
    pub const DETAIL_FLOOR: f64 = 0.074;
    /// Light halo limit (linear step) and the dark halo limit
    /// `1 / (1 / (SLOPE * Y^2) + 1 / MAX)`.
    pub const LIGHT_HALO: f32 = 0.237;
    pub const DARK_HALO_SLOPE: f32 = 5.9;
    pub const DARK_HALO_MAX: f32 = 0.225;
    /// Masking: pre-blur of `sqrt(luma)`, blur of its gradient energy, and
    /// the threshold `THRESHOLD * (masking / 100) ^ POWER` (gradient of
    /// `sqrt(luma)` per reference pixel).
    pub const MASK_PRE_SIGMA: f64 = 1.31;
    pub const MASK_ENERGY_SIGMA: f64 = 1.17;
    pub const MASK_THRESHOLD: f64 = 0.0874;
    pub const MASK_POWER: f64 = 2.67;
    /// Luminance NR: range cut of the Tukey weight in `sqrt(luma)` at
    /// amount 100 and its power in amount / 100, its factor per a-trous
    /// level (coarser levels keep smaller steps), and the blend power.
    pub const NOISE_RANGE: f64 = 0.12;
    pub const NOISE_RANGE_POWER: f64 = 0.05;
    pub const NOISE_RANGE_DECAY: f64 = 0.77;
    pub const NOISE_BLEND_POWER: f64 = 0.62;
    /// Range weight every tap keeps beyond the cut (a slight leak across
    /// strong edges and fine gratings, as Lightroom shows).
    pub const NOISE_LEAK: f32 = 0.01;
    /// A-trous levels (dilations 1, 2, 4 at the reference scale).
    pub const NOISE_LEVELS: usize = 3;
    /// Color NR: Gaussian sigma of the chroma ratios, and the amount at
    /// which it is fully applied.
    pub const COLOR_SIGMA: f64 = 0.9;
    pub const COLOR_FULL_AMOUNT: f64 = 25.0;
}

/// Linear luma below this is treated as this level by luminance NR.
const LUMA_FLOOR: f32 = 3e-5;
/// Sharpening scales RGB by the luma ratio above this linear level (about
/// sRGB code 25) and adds the change evenly below it.
const SHARPEN_RATIO_FLOOR: f32 = 0.01;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceSpace {
    LinearSrgb,
    LinearProPhoto,
}

impl SourceSpace {
    fn luma_weights(self) -> [f32; 3] {
        match self {
            Self::LinearSrgb => REC709_LUMA_F32,
            Self::LinearProPhoto => PP_LUMA_F32,
        }
    }
}

/// Settings for a pipeline whose source already includes v6 NR. Sharpening
/// stays active; only the source operations are neutralized.
pub(crate) fn source_noise_disabled(
    settings: &crate::settings::DevelopSettings,
) -> crate::settings::DevelopSettings {
    let mut downstream = settings.clone();
    if let Some(detail) = downstream.detail.as_mut() {
        detail.luminance_noise_reduction = 0.0;
        if detail.color_noise_reduction.is_some() {
            detail.color_noise_reduction = Some(0.0);
        }
    }
    downstream
}

#[derive(Clone, Debug, PartialEq)]
pub enum DetailError {
    InvalidDimensions,
    InvalidLength { expected: usize, actual: usize },
    NonFiniteInput(usize),
    NonFiniteOutput(usize),
}

impl fmt::Display for DetailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDimensions => write!(f, "invalid detail image dimensions"),
            Self::InvalidLength { expected, actual } => {
                write!(
                    f,
                    "invalid detail RGB length: expected {expected}, got {actual}"
                )
            }
            Self::NonFiniteInput(index) => write!(f, "non-finite detail input at {index}"),
            Self::NonFiniteOutput(index) => write!(f, "non-finite detail output at {index}"),
        }
    }
}

impl std::error::Error for DetailError {}

fn validate(source: &[f32], width: usize, height: usize) -> Result<(), DetailError> {
    let expected = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(3))
        .filter(|_| width > 0 && height > 0)
        .ok_or(DetailError::InvalidDimensions)?;
    if source.len() != expected {
        return Err(DetailError::InvalidLength {
            expected,
            actual: source.len(),
        });
    }
    if let Some(index) = source.iter().position(|value| !value.is_finite()) {
        return Err(DetailError::NonFiniteInput(index));
    }
    Ok(())
}

fn reference_scale(whole_long_edge: usize) -> f64 {
    whole_long_edge.max(1) as f64 / 1500.0
}

/// Applies v6 source noise reduction. `raster_color_amount` is used only for
/// raster sources; signed RAW applies the effective R209 amount in its
/// canonical preparation cache and passes `None` here, avoiding a second
/// chroma pass.
pub fn reduce_noise(
    source: &[f32],
    width: usize,
    height: usize,
    whole_long_edge: usize,
    space: SourceSpace,
    detail: DetailSettings,
    raster_color_amount: Option<f64>,
) -> Result<Vec<f32>, DetailError> {
    validate(source, width, height)?;
    let mut output = source.to_vec();
    if let Some(amount) = raster_color_amount.filter(|amount| *amount > 0.0) {
        raster_chroma(&mut output, width, height, whole_long_edge, space, amount);
    }
    if detail.luminance_noise_reduction > 0.0 {
        edge_avoiding_luminance(
            &mut output,
            width,
            height,
            whole_long_edge,
            space,
            detail.luminance_noise_reduction,
        );
    }
    if let Some(index) = output.iter().position(|value| !value.is_finite()) {
        return Err(DetailError::NonFiniteOutput(index));
    }
    Ok(output)
}

/// Source preparation uses the old frozen path unless v6 explicitly owns
/// the color amount. This keeps every legacy RAW pixel unchanged.
pub(crate) fn reduce_raw_chroma(
    source: &[f32],
    width: usize,
    height: usize,
    settings: &crate::settings::DevelopSettings,
) -> Result<Vec<f32>, crate::raw_chroma::RawChromaError> {
    match settings
        .detail
        .and_then(|detail| detail.color_noise_reduction)
    {
        Some(amount) => crate::raw_chroma::apply_detail(source, width, height, amount),
        None => crate::raw_chroma::apply(
            source,
            width,
            height,
            settings.color_noise_reduction.min(50.0),
        ),
    }
}

/// Raster color NR: each pixel keeps its luma and takes the chroma ratios
/// (`RGB / luma`) of a small Gaussian neighbourhood. Neighbours are weighted
/// by their linear level, which is `blur(RGB) / blur(luma)`.
fn raster_chroma(
    rgb: &mut [f32],
    width: usize,
    height: usize,
    whole_long_edge: usize,
    space: SourceSpace,
    amount: f64,
) {
    let weights = space.luma_weights();
    let blend = (amount / calibration::COLOR_FULL_AMOUNT).min(1.0) as f32;
    // Small renders keep at least half a pixel (an explicit amount acts).
    let sigma = (calibration::COLOR_SIGMA * reference_scale(whole_long_edge)).max(0.5);
    let blurred = gaussian_rgb(rgb, width, height, sigma);
    for (pixel, mean) in rgb.chunks_exact_mut(3).zip(blurred.chunks_exact(3)) {
        let luma = pixel[0] * weights[0] + pixel[1] * weights[1] + pixel[2] * weights[2];
        let mean_luma = mean[0] * weights[0] + mean[1] * weights[1] + mean[2] * weights[2];
        if !(luma > 0.0 && mean_luma > LUMA_FLOOR) {
            continue;
        }
        let scale = luma / mean_luma;
        for channel in 0..3 {
            pixel[channel] += blend * (mean[channel] * scale - pixel[channel]);
        }
    }
}

/// Luminance NR on `v = sqrt(luma)`: an edge-avoiding a-trous filter
/// (B3-spline taps at dilations 1, 2, 4 times the reference scale; each
/// pass reads its Tukey range weights from its own input), blended in by
/// the amount. The change of `v` is added to the square root of every
/// channel, which keeps chroma (and moves it like Lightroom does).
fn edge_avoiding_luminance(
    rgb: &mut [f32],
    width: usize,
    height: usize,
    whole_long_edge: usize,
    space: SourceSpace,
    amount: f64,
) {
    let weights = space.luma_weights();
    let scale = reference_scale(whole_long_edge);
    let strength = amount / 100.0;
    let blend = libm::pow(strength, calibration::NOISE_BLEND_POWER).min(1.0) as f32;
    let mut range = calibration::NOISE_RANGE * libm::pow(strength, calibration::NOISE_RANGE_POWER);
    let value: Vec<f32> = rgb
        .chunks_exact(3)
        .map(|pixel| {
            (pixel[0] * weights[0] + pixel[1] * weights[1] + pixel[2] * weights[2])
                .max(LUMA_FLOOR)
                .sqrt()
        })
        .collect();
    let mut current = value.clone();
    let mut next = vec![0.0f32; value.len()];
    for level in 0..calibration::NOISE_LEVELS {
        let dilation = (libm::round((1usize << level) as f64 * scale) as usize).max(1);
        let inverse_range_square = (1.0 / (range * range)) as f32;
        edge_avoiding_rows(
            &current,
            &mut next,
            width,
            height,
            dilation,
            inverse_range_square,
        );
        edge_avoiding_columns(
            &next,
            &mut current,
            width,
            height,
            dilation,
            inverse_range_square,
        );
        range *= calibration::NOISE_RANGE_DECAY;
    }
    for ((pixel, before), after) in rgb.chunks_exact_mut(3).zip(&value).zip(&current) {
        let delta = blend * (after - before);
        for channel in pixel.iter_mut() {
            let root = signed_sqrt(*channel) + delta;
            *channel = root * root.abs();
        }
    }
}

#[inline]
fn signed_sqrt(value: f32) -> f32 {
    if value >= 0.0 {
        value.sqrt()
    } else {
        -(-value).sqrt()
    }
}

const B3_TAPS: [(usize, f32); 2] = [(1, 4.0 / 16.0), (2, 1.0 / 16.0)];
const B3_CENTER: f32 = 6.0 / 16.0;

/// Tukey biweight of the range difference plus the leak.
#[inline]
fn range_weight(difference: f32, inverse_range_square: f32) -> f32 {
    let t = 1.0 - difference * difference * inverse_range_square;
    if t > 0.0 {
        t * t + calibration::NOISE_LEAK
    } else {
        calibration::NOISE_LEAK
    }
}

fn edge_avoiding_rows(
    source: &[f32],
    output: &mut [f32],
    width: usize,
    height: usize,
    dilation: usize,
    inverse_range_square: f32,
) {
    for y in 0..height {
        let row = y * width;
        for x in 0..width {
            let center = source[row + x];
            let mut sum = source[row + x] * B3_CENTER;
            let mut total = B3_CENTER;
            for (step, tap) in B3_TAPS {
                let offset = step * dilation;
                for index in [
                    row + x.saturating_sub(offset),
                    row + (x + offset).min(width - 1),
                ] {
                    let weight = tap * range_weight(source[index] - center, inverse_range_square);
                    sum += weight * source[index];
                    total += weight;
                }
            }
            output[row + x] = sum / total;
        }
    }
}

fn edge_avoiding_columns(
    source: &[f32],
    output: &mut [f32],
    width: usize,
    height: usize,
    dilation: usize,
    inverse_range_square: f32,
) {
    let mut sum = vec![0.0f32; width];
    let mut total = vec![0.0f32; width];
    for y in 0..height {
        let row = y * width;
        for x in 0..width {
            sum[x] = source[row + x] * B3_CENTER;
            total[x] = B3_CENTER;
        }
        for (step, tap) in B3_TAPS {
            let offset = step * dilation;
            for other in [
                y.saturating_sub(offset) * width,
                (y + offset).min(height - 1) * width,
            ] {
                for x in 0..width {
                    let weight = tap
                        * range_weight(source[other + x] - source[row + x], inverse_range_square);
                    sum[x] += weight * source[other + x];
                    total[x] += weight;
                }
            }
        }
        for x in 0..width {
            output[row + x] = sum[x] / total[x];
        }
    }
}

/// Applies linear-light luma USM in place. The plane is output-sized linear
/// sRGB, never decoded back from `Rendered.rgba`. Interactive renders may
/// omit it; a following Final render always recomputes this exact operation.
pub fn sharpen_linear_srgb(
    rgb: &mut [f32],
    width: usize,
    height: usize,
    whole_long_edge: usize,
    settings: SharpeningSettings,
) -> Result<(), DetailError> {
    validate(rgb, width, height)?;
    if settings.amount == 0.0 {
        return Ok(());
    }
    let scale = reference_scale(whole_long_edge);
    let luma: Vec<f32> = rgb
        .chunks_exact(3)
        .map(|pixel| {
            pixel[0] * REC709_LUMA_F32[0]
                + pixel[1] * REC709_LUMA_F32[1]
                + pixel[2] * REC709_LUMA_F32[2]
        })
        .collect();
    // A continuous Gaussian keeps every Radius distinct (a rounded box made
    // 1.1 and 1.2 the same operation).
    let sigma = reference_sigma(settings.radius);
    let blurred = gaussian_mean(&luma, width, height, sigma * scale);
    let gain = sharpening_gain(settings, sigma) as f32;
    let mask = (settings.masking > 0.0).then(|| edge_mask(&luma, width, height, scale, settings));
    for (index, pixel) in rgb.chunks_exact_mut(3).enumerate() {
        let level = luma[index];
        let mut delta = gain * (level - blurred[index]);
        if let Some(mask) = &mask {
            delta *= mask[index];
        }
        let delta = if delta >= 0.0 {
            soft_limit(delta, calibration::LIGHT_HALO)
        } else {
            let square = level.max(0.0) * level.max(0.0);
            let slope = calibration::DARK_HALO_SLOPE * square;
            let limit = slope * calibration::DARK_HALO_MAX / (slope + calibration::DARK_HALO_MAX);
            if limit > 0.0 {
                -soft_limit(-delta, limit)
            } else {
                0.0
            }
        };
        // Scale RGB to the new luma so chroma ratios stay (as Lightroom: the
        // chroma of colored noise grows with the luma it carries). Near
        // black the ratio is taken against the floor and the rest is added
        // evenly, so dim colored noise is not multiplied up.
        let target = level + delta;
        if level >= SHARPEN_RATIO_FLOOR {
            let ratio = target / level;
            pixel[0] *= ratio;
            pixel[1] *= ratio;
            pixel[2] *= ratio;
        } else {
            let ratio = target / SHARPEN_RATIO_FLOOR;
            let rest = target - level * ratio;
            pixel[0] = pixel[0] * ratio + rest;
            pixel[1] = pixel[1] * ratio + rest;
            pixel[2] = pixel[2] * ratio + rest;
        }
    }
    if let Some(index) = rgb.iter().position(|value| !value.is_finite()) {
        return Err(DetailError::NonFiniteOutput(index));
    }
    Ok(())
}

/// Gaussian sigma of the sharpening blur at the reference scale.
fn reference_sigma(radius: f64) -> f64 {
    calibration::SHARP_SIGMA * libm::pow(radius.clamp(0.5, 3.0), calibration::SHARP_SIGMA_POWER)
}

fn sharpening_gain(settings: SharpeningSettings, sigma: f64) -> f64 {
    let detail =
        |value: f64| libm::pow(value, calibration::DETAIL_POWER) + calibration::DETAIL_FLOOR;
    calibration::SHARP_GAIN
        * libm::pow(settings.amount / 100.0, calibration::SHARP_AMOUNT_POWER)
        * detail(settings.detail / 100.0)
        / detail(0.25)
        * libm::pow(sigma, -calibration::SHARP_GAIN_SIGMA_POWER)
}

/// `L * tanh(x / L)` by its [3/2] Pade form, exact 1 beyond |x / L| = 3.
#[inline]
fn soft_limit(value: f32, limit: f32) -> f32 {
    let u = (value / limit).min(3.0);
    let u2 = u * u;
    limit * u * (27.0 + u2) / (27.0 + 9.0 * u2)
}

/// Masking: `e / (e + T^2)` with `e` the blurred gradient energy of a
/// blurred `sqrt(luma)` (per reference pixel) and `T` the threshold.
fn edge_mask(
    luma: &[f32],
    width: usize,
    height: usize,
    scale: f64,
    settings: SharpeningSettings,
) -> Vec<f32> {
    let value: Vec<f32> = luma.iter().map(|level| level.max(0.0).sqrt()).collect();
    let smooth = gaussian_mean(&value, width, height, calibration::MASK_PRE_SIGMA * scale);
    let half_scale = (0.5 * scale) as f32;
    let mut energy = vec![0.0f32; luma.len()];
    for y in 0..height {
        let up = y.saturating_sub(1) * width;
        let down = (y + 1).min(height - 1) * width;
        let row = y * width;
        for x in 0..width {
            let dx = (smooth[row + (x + 1).min(width - 1)] - smooth[row + x.saturating_sub(1)])
                * half_scale;
            let dy = (smooth[down + x] - smooth[up + x]) * half_scale;
            energy[row + x] = dx * dx + dy * dy;
        }
    }
    let energy = gaussian_mean(
        &energy,
        width,
        height,
        calibration::MASK_ENERGY_SIGMA * scale,
    );
    let threshold =
        calibration::MASK_THRESHOLD * libm::pow(settings.masking / 100.0, calibration::MASK_POWER);
    let threshold_square = (threshold * threshold) as f32;
    energy
        .into_iter()
        .map(|value| value / (value + threshold_square))
        .collect()
}

/// Maximum pixel reach read by [`sharpen_linear_srgb`]. Geometry plans use
/// this to size an internal crop halo. A halo clipped by the actual photo
/// boundary may be smaller; the filter clamps at that photo boundary.
pub fn sharpening_reach(whole_long_edge: usize, settings: SharpeningSettings) -> usize {
    let scale = reference_scale(whole_long_edge);
    let blur = gaussian_radius(reference_sigma(settings.radius) * scale);
    if settings.masking > 0.0 {
        blur.max(
            gaussian_radius(calibration::MASK_PRE_SIGMA * scale)
                + 1
                + gaussian_radius(calibration::MASK_ENERGY_SIGMA * scale),
        )
    } else {
        blur
    }
}

fn gaussian_radius(sigma: f64) -> usize {
    libm::ceil(3.0 * sigma.max(1.0 / 1024.0)) as usize
}

fn gaussian_kernel(sigma: f64) -> Vec<f32> {
    let sigma = sigma.max(1.0 / 1024.0);
    let radius = gaussian_radius(sigma);
    let mut kernel = Vec::with_capacity(radius + 1);
    let mut total = 1.0f64;
    kernel.push(1.0f32);
    for offset in 1..=radius {
        let x = offset as f64;
        let weight = libm::exp(-(x * x) / (2.0 * sigma * sigma));
        kernel.push(weight as f32);
        total += 2.0 * weight;
    }
    let inverse = (1.0 / total) as f32;
    for weight in &mut kernel {
        *weight *= inverse;
    }
    kernel
}

fn gaussian_mean(source: &[f32], width: usize, height: usize, sigma: f64) -> Vec<f32> {
    let kernel = gaussian_kernel(sigma);
    let mut horizontal = vec![0.0f32; source.len()];
    for y in 0..height {
        let row = &source[y * width..(y + 1) * width];
        for x in 0..width {
            let mut sum = row[x] * kernel[0];
            for (offset, weight) in kernel.iter().copied().enumerate().skip(1) {
                sum += weight * (row[x.saturating_sub(offset)] + row[(x + offset).min(width - 1)]);
            }
            horizontal[y * width + x] = sum;
        }
    }
    let mut output = vec![0.0f32; source.len()];
    for y in 0..height {
        let center = &horizontal[y * width..(y + 1) * width];
        let destination = &mut output[y * width..(y + 1) * width];
        for (value, source) in destination.iter_mut().zip(center) {
            *value = source * kernel[0];
        }
        for (offset, weight) in kernel.iter().copied().enumerate().skip(1) {
            let up = y.saturating_sub(offset) * width;
            let down = (y + offset).min(height - 1) * width;
            for (x, value) in destination.iter_mut().enumerate() {
                *value += weight * (horizontal[up + x] + horizontal[down + x]);
            }
        }
    }
    output
}

/// [`gaussian_mean`] of interleaved RGB.
fn gaussian_rgb(source: &[f32], width: usize, height: usize, sigma: f64) -> Vec<f32> {
    let kernel = gaussian_kernel(sigma);
    let mut horizontal = vec![0.0f32; source.len()];
    for y in 0..height {
        let row = &source[y * width * 3..(y + 1) * width * 3];
        for x in 0..width {
            let mut sum = [
                row[x * 3] * kernel[0],
                row[x * 3 + 1] * kernel[0],
                row[x * 3 + 2] * kernel[0],
            ];
            for (offset, weight) in kernel.iter().copied().enumerate().skip(1) {
                let left = x.saturating_sub(offset) * 3;
                let right = (x + offset).min(width - 1) * 3;
                for (channel, value) in sum.iter_mut().enumerate() {
                    *value += weight * (row[left + channel] + row[right + channel]);
                }
            }
            horizontal[(y * width + x) * 3..(y * width + x) * 3 + 3].copy_from_slice(&sum);
        }
    }
    let stride = width * 3;
    let mut output = vec![0.0f32; source.len()];
    for y in 0..height {
        let center = &horizontal[y * stride..(y + 1) * stride];
        let destination = &mut output[y * stride..(y + 1) * stride];
        for (value, source) in destination.iter_mut().zip(center) {
            *value = source * kernel[0];
        }
        for (offset, weight) in kernel.iter().copied().enumerate().skip(1) {
            let up = y.saturating_sub(offset) * stride;
            let down = (y + offset).min(height - 1) * stride;
            for (x, value) in destination.iter_mut().enumerate() {
                *value += weight * (horizontal[up + x] + horizontal[down + x]);
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variance(values: &[f32]) -> f32 {
        let mean = values.iter().sum::<f32>() / values.len() as f32;
        values
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f32>()
            / values.len() as f32
    }

    fn reference_gaussian(source: &[f32], width: usize, height: usize, sigma: f64) -> Vec<f32> {
        let kernel = gaussian_kernel(sigma);
        let radius = kernel.len() as isize - 1;
        (0..height)
            .flat_map(|y| {
                let kernel = &kernel;
                (0..width).map(move |x| {
                    let mut sum = 0.0f64;
                    for dy in -radius..=radius {
                        let sy = (y as isize + dy).clamp(0, height as isize - 1) as usize;
                        for dx in -radius..=radius {
                            let sx = (x as isize + dx).clamp(0, width as isize - 1) as usize;
                            sum += f64::from(kernel[dy.unsigned_abs()])
                                * f64::from(kernel[dx.unsigned_abs()])
                                * f64::from(source[sy * width + sx]);
                        }
                    }
                    sum as f32
                })
            })
            .collect()
    }

    #[test]
    fn gaussians_match_an_independent_clamped_convolution_on_tiny_images() {
        for (width, height) in [(1, 1), (1, 5), (5, 1), (2, 2), (6, 3)] {
            let source: Vec<f32> = (0..width * height)
                .map(|index| 0.125 + index as f32 * 0.25)
                .collect();
            let rgb: Vec<f32> = source
                .iter()
                .flat_map(|value| [*value, value * 0.5, 1.0 - value])
                .collect();
            for sigma in [0.3, 0.9, 1.7, 4.0] {
                let expected = reference_gaussian(&source, width, height, sigma);
                let actual = gaussian_mean(&source, width, height, sigma);
                let colored = gaussian_rgb(&rgb, width, height, sigma);
                for (index, expected) in expected.iter().enumerate() {
                    assert!(
                        (actual[index] - expected).abs() <= 2e-6,
                        "{width}x{height} sigma {sigma}: {} vs {expected}",
                        actual[index]
                    );
                    assert!((colored[index * 3] - expected).abs() <= 2e-6);
                }
                let constant = vec![0.375; width * height];
                assert!(gaussian_mean(&constant, width, height, sigma)
                    .iter()
                    .all(|value| (*value - 0.375).abs() <= 2e-6));
            }
        }
    }

    #[test]
    fn active_detail_keeps_tiny_constant_colors_constant() {
        for (width, height) in [(1, 1), (1, 7), (7, 1), (2, 2)] {
            let source = [0.18, 0.42, 0.77].repeat(width * height);
            let reduced = reduce_noise(
                &source,
                width,
                height,
                9_000,
                SourceSpace::LinearSrgb,
                DetailSettings {
                    luminance_noise_reduction: 100.0,
                    ..DetailSettings::default()
                },
                Some(100.0),
            )
            .unwrap();
            for (actual, expected) in reduced.iter().zip(&source) {
                assert!((actual - expected).abs() <= 2e-6);
            }
            let mut sharpened = source.clone();
            sharpen_linear_srgb(
                &mut sharpened,
                width,
                height,
                9_000,
                SharpeningSettings {
                    amount: 150.0,
                    radius: 3.0,
                    detail: 100.0,
                    masking: 0.0,
                },
            )
            .unwrap();
            for (actual, expected) in sharpened.iter().zip(&source) {
                assert!((actual - expected).abs() <= 1e-5);
            }
        }
    }

    #[test]
    fn seeded_flat_noise_falls_and_step_edge_is_retained() {
        let (width, height) = (48, 24);
        let mut seed = 7u32;
        let mut source = Vec::with_capacity(width * height * 3);
        for _y in 0..height {
            for x in 0..width {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = ((seed >> 8) as f32 / 16_777_215.0 - 0.5) * 0.08;
                let value = if x < width / 2 { 0.25 } else { 0.75 };
                source.extend_from_slice(&[value + noise; 3]);
            }
        }
        let settings = DetailSettings {
            luminance_noise_reduction: 80.0,
            ..DetailSettings::default()
        };
        let filtered = reduce_noise(
            &source,
            width,
            height,
            1500,
            SourceSpace::LinearSrgb,
            settings,
            None,
        )
        .unwrap();
        let before: Vec<_> = source
            .chunks_exact(3)
            .take(width / 3)
            .map(|p| p[1])
            .collect();
        let after: Vec<_> = filtered
            .chunks_exact(3)
            .take(width / 3)
            .map(|p| p[1])
            .collect();
        assert!(variance(&after) < variance(&before));
        let row = height / 2;
        let left = filtered[(row * width + width / 2 - 3) * 3 + 1];
        let right = filtered[(row * width + width / 2 + 3) * 3 + 1];
        assert!(right - left > 0.35);
    }

    #[test]
    fn sharpening_amount_zero_is_exact_and_continuous_radius_acts() {
        let (width, height) = (31, 9);
        let mut source = vec![0.3; width * height * 3];
        for y in 0..height {
            for x in width / 2..width {
                source[(y * width + x) * 3..(y * width + x) * 3 + 3].fill(0.7);
            }
        }
        let mut zero = source.clone();
        sharpen_linear_srgb(
            &mut zero,
            width,
            height,
            1500,
            SharpeningSettings::default(),
        )
        .unwrap();
        assert_eq!(zero, source);
        let apply = |detail, masking| {
            let mut value = source.clone();
            sharpen_linear_srgb(
                &mut value,
                width,
                height,
                1500,
                SharpeningSettings {
                    amount: 100.0,
                    radius: 1.5,
                    detail,
                    masking,
                },
            )
            .unwrap();
            value
        };
        let low = apply(0.0, 0.0);
        let high = apply(100.0, 0.0);
        assert_ne!(low, high, "detail must change the high-frequency weight");
        let edge = (height / 2 * width + width / 2 - 1) * 3;
        assert!((low[edge] - source[edge]).abs() > 0.01);

        let at_radius = |radius| {
            let mut value = source.clone();
            sharpen_linear_srgb(
                &mut value,
                width,
                height,
                1500,
                SharpeningSettings {
                    amount: 100.0,
                    radius,
                    detail: 35.0,
                    masking: 0.0,
                },
            )
            .unwrap();
            value
        };
        let mut previous = at_radius(0.5);
        for step in 6..=30 {
            let current = at_radius(step as f64 / 10.0);
            assert_ne!(previous, current, "radius {} must act", step as f64 / 10.0);
            previous = current;
        }
    }

    #[test]
    fn masking_suppresses_seeded_flat_noise_but_preserves_the_real_edge() {
        let (width, height) = (96, 48);
        let mut state = 0x32d3_91abu32;
        let mut source = Vec::with_capacity(width * height * 3);
        for _y in 0..height {
            for x in 0..width {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let noise = (state as f32 / u32::MAX as f32 - 0.5) * 0.035;
                let value = if x < width / 2 { 0.3 } else { 0.7 };
                source.extend_from_slice(&[value + noise; 3]);
            }
        }
        let apply = |masking, detail| {
            let mut output = source.clone();
            sharpen_linear_srgb(
                &mut output,
                width,
                height,
                1500,
                SharpeningSettings {
                    amount: 120.0,
                    radius: 1.35,
                    detail,
                    masking,
                },
            )
            .unwrap();
            output
        };
        let unmasked = apply(0.0, 25.0);
        let masked = apply(100.0, 25.0);
        let flat_delta_variance = |rendered: &[f32]| {
            let mut deltas = Vec::new();
            for y in 4..height - 4 {
                for x in 4..width / 2 - 8 {
                    let index = (y * width + x) * 3 + 1;
                    deltas.push(rendered[index] - source[index]);
                }
            }
            variance(&deltas)
        };
        assert!(flat_delta_variance(&masked) < flat_delta_variance(&unmasked) * 0.35);
        let edge_response = |rendered: &[f32]| {
            let y = height / 2;
            let left = (y * width + width / 2 - 1) * 3 + 1;
            let right = (y * width + width / 2) * 3 + 1;
            (rendered[right] - rendered[left]) - (source[right] - source[left])
        };
        assert!(edge_response(&masked) > 0.01);
        let low_detail = apply(0.0, 0.0);
        let high_detail = apply(0.0, 100.0);
        let high_frequency_response = |rendered: &[f32]| {
            let mut total = 0.0f32;
            for y in 4..height - 4 {
                for x in 4..width / 2 - 8 {
                    let i = (y * width + x) * 3 + 1;
                    total += (rendered[i] - source[i]).abs();
                }
            }
            total
        };
        assert!(
            (high_frequency_response(&high_detail) - high_frequency_response(&low_detail)).abs()
                > 0.01
        );
    }

    #[test]
    fn sharpening_moves_luma_keeps_chroma_ratios_and_signed_headroom_finite() {
        let mut rgb = vec![
            -0.12, 0.08, 1.25, 0.15, 0.35, 1.52, 0.7, 0.9, 2.1, 0.004, -0.001, 0.002,
        ];
        let original = rgb.clone();
        sharpen_linear_srgb(
            &mut rgb,
            4,
            1,
            1500,
            SharpeningSettings {
                amount: 150.0,
                radius: 1.2,
                detail: 65.0,
                masking: 0.0,
            },
        )
        .unwrap();
        let luma = |pixel: &[f32]| {
            pixel[0] * REC709_LUMA_F32[0]
                + pixel[1] * REC709_LUMA_F32[1]
                + pixel[2] * REC709_LUMA_F32[2]
        };
        let mut moved = 0;
        for (before, after) in original.chunks_exact(3).zip(rgb.chunks_exact(3)) {
            assert!(after.iter().all(|value| value.is_finite()));
            let (old, new) = (luma(before), luma(after));
            if (new - old).abs() > 1e-4 {
                moved += 1;
            }
            if old >= SHARPEN_RATIO_FLOOR {
                // Chroma ratios stay: every channel scales with the luma.
                let ratio = new / old;
                for channel in 0..3 {
                    assert!(
                        (after[channel] - before[channel] * ratio).abs() <= 2e-6,
                        "{before:?} -> {after:?}"
                    );
                }
            } else {
                // Near black the change is not a multiple of dim chroma.
                let spread = |pixel: &[f32]| pixel[0] - pixel[2];
                assert!((spread(after) - spread(before)).abs() <= spread(before).abs() * 3.0);
            }
        }
        assert!(moved >= 2, "sharpening did not act: {rgb:?}");
    }

    #[test]
    fn rejects_nonfinite_and_handles_tiny_signed_headroom() {
        assert!(reduce_noise(
            &[f32::NAN, 0.0, 0.0],
            1,
            1,
            1,
            SourceSpace::LinearProPhoto,
            DetailSettings::default(),
            None,
        )
        .is_err());
        let mut tiny = [-0.2, 0.1, 1.4];
        sharpen_linear_srgb(
            &mut tiny,
            1,
            1,
            1,
            SharpeningSettings {
                amount: 100.0,
                ..SharpeningSettings::default()
            },
        )
        .unwrap();
        assert!(tiny.iter().all(|value| value.is_finite()));
    }
}
