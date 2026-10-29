//! NIHO 3 signed-RGB guided chroma reduction (R209 frozen contract).

use std::fmt;

const LUMA: [f32; 3] = [0.2880402, 0.7118741, 0.0000857];
const FLOOR: f32 = 3e-5;
const WINDOW: usize = 17;
const RADIUS: usize = WINDOW / 2;
const AREA: f64 = (WINDOW * WINDOW) as f64;
const LOW_RANGE_POWER: f64 = 0.652453397114278;
// The guided filter uses two box passes. A row depends on at most 2 * RADIUS
// source rows on either side; keep that halo when filtering a stripe.
const STRIPE_ROWS: usize = 256;
const STRIPE_HALO: usize = 2 * RADIUS;

mod simd;
use simd::LANES;

#[derive(Clone, Debug, PartialEq)]
pub enum RawChromaError {
    InvalidDimensions,
    InvalidLength { expected: usize, actual: usize },
    NonFiniteInput(usize),
    InvalidAmount(f64),
    DerivedNonFinite(&'static str, usize),
}

impl fmt::Display for RawChromaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDimensions => write!(f, "invalid image dimensions"),
            Self::InvalidLength { expected, actual } => {
                write!(f, "invalid RGB length: expected {expected}, got {actual}")
            }
            Self::NonFiniteInput(index) => write!(f, "non-finite RGB sample at {index}"),
            Self::InvalidAmount(value) => {
                write!(
                    f,
                    "color noise reduction must be within 0..100, got {value}"
                )
            }
            Self::DerivedNonFinite(stage, index) => {
                write!(f, "non-finite {stage} value at pixel {index}")
            }
        }
    }
}

impl std::error::Error for RawChromaError {}

/// Applies the frozen continuous CNR contract. Amount zero is an exact copy.
pub fn apply(
    source: &[f32],
    width: usize,
    height: usize,
    amount: f64,
) -> Result<Vec<f32>, RawChromaError> {
    validate_pixels(source, width, height, amount)?;
    if amount == 0.0 {
        return Ok(source.to_vec());
    }
    let alpha = (amount <= 25.0).then(|| libm::pow(amount / 25.0, LOW_RANGE_POWER) as f32);
    let beta = ((amount - 25.0) / 25.0).min(1.0) as f32;
    stripes(
        source,
        width,
        height,
        |halo, halo_rows, center, destination| {
            let kernel25 = guided(halo, width, halo_rows, halo.len() / 3, 0.1)?;
            if let Some(alpha) = alpha {
                for ((original, filtered), result) in halo[center.clone()]
                    .iter()
                    .zip(&kernel25[center])
                    .zip(destination)
                {
                    *result = *original + alpha * (*filtered - *original);
                }
            } else {
                let kernel100 = guided(halo, width, halo_rows, halo.len() / 3, 0.4)?;
                for ((low, high), result) in kernel25[center.clone()]
                    .iter()
                    .zip(&kernel100[center])
                    .zip(destination)
                {
                    *result = *low + beta * (*high - *low);
                }
            }
            Ok(())
        },
    )
}

/// `filter(halo, halo_rows, center, destination)` on every stripe of
/// `STRIPE_ROWS` rows with its halo (`center`: the stripe's values in
/// `halo`), into the stripe's part of the output. The stripes read only the
/// source, so they may run on different threads; the error is the first
/// failing stripe's, as of the loop in order (#150).
fn stripes(
    source: &[f32],
    width: usize,
    height: usize,
    filter: impl Fn(&[f32], usize, std::ops::Range<usize>, &mut [f32]) -> Result<(), RawChromaError>
        + Sync
        + Send,
) -> Result<Vec<f32>, RawChromaError> {
    let mut output = vec![0.0; source.len()];
    let mut errors: Vec<Option<RawChromaError>> =
        (0..height.div_ceil(STRIPE_ROWS)).map(|_| None).collect();
    crate::par::for_each_row_pair_mut(
        &mut output,
        STRIPE_ROWS * width * 3,
        &mut errors,
        1,
        |stripe, destination, error| {
            let start = stripe * STRIPE_ROWS;
            let end = start + destination.len() / (width * 3);
            let halo_start = start.saturating_sub(STRIPE_HALO);
            let halo_end = end.saturating_add(STRIPE_HALO).min(height);
            let halo = &source[halo_start * width * 3..halo_end * width * 3];
            let center = (start - halo_start) * width * 3..(end - halo_start) * width * 3;
            if let Err(failed) = filter(halo, halo_end - halo_start, center, destination) {
                error[0] = Some(stripe_error(failed, halo_start * width));
            }
        },
    );
    match errors.into_iter().flatten().next() {
        Some(error) => Err(error),
        None => Ok(output),
    }
}

/// Explicit v6 detail control. The frozen 0..50 domain is unchanged; above
/// 50, increase guided-filter regularization continuously up to 4x. This
/// keeps the whole slider useful without applying legacy and v6 NR twice.
/// The extended range is a NIHO approximation, not an LR calibration.
pub fn apply_detail(
    source: &[f32],
    width: usize,
    height: usize,
    amount: f64,
) -> Result<Vec<f32>, RawChromaError> {
    if amount <= 50.0 {
        return apply(source, width, height, amount);
    }
    validate_pixels(source, width, height, amount)?;
    let epsilon = (0.4 * libm::pow(4.0, (amount - 50.0) / 50.0)) as f32;
    stripes(
        source,
        width,
        height,
        |halo, halo_rows, center, destination| {
            let filtered = guided(halo, width, halo_rows, halo.len() / 3, epsilon)?;
            destination.copy_from_slice(&filtered[center]);
            Ok(())
        },
    )
}

fn stripe_error(error: RawChromaError, pixel_offset: usize) -> RawChromaError {
    match error {
        RawChromaError::DerivedNonFinite(stage, index) => {
            RawChromaError::DerivedNonFinite(stage, index + pixel_offset)
        }
        other => other,
    }
}

/// Validates the frozen CNR input without allocating an output image.
/// NIHO 3 uses this for amount zero, where the Session-owned source itself
/// is the exact CNR result.
pub(crate) fn validate(
    source: &[f32],
    width: usize,
    height: usize,
    amount: f64,
) -> Result<(), RawChromaError> {
    validate_pixels(source, width, height, amount).map(|_| ())
}

fn validate_pixels(
    source: &[f32],
    width: usize,
    height: usize,
    amount: f64,
) -> Result<usize, RawChromaError> {
    if width == 0 || height == 0 || width > isize::MAX as usize || height > isize::MAX as usize {
        return Err(RawChromaError::InvalidDimensions);
    }
    let pixels = width
        .checked_mul(height)
        .ok_or(RawChromaError::InvalidDimensions)?;
    let expected = pixels
        .checked_mul(3)
        .ok_or(RawChromaError::InvalidDimensions)?;
    if source.len() != expected {
        return Err(RawChromaError::InvalidLength {
            expected,
            actual: source.len(),
        });
    }
    if let Some(index) = source.iter().position(|v| !v.is_finite()) {
        return Err(RawChromaError::NonFiniteInput(index));
    }
    if !amount.is_finite() || !(0.0..=100.0).contains(&amount) {
        return Err(RawChromaError::InvalidAmount(amount));
    }
    Ok(pixels)
}

fn guided(
    source: &[f32],
    width: usize,
    height: usize,
    pixels: usize,
    epsilon: f32,
) -> Result<Vec<f32>, RawChromaError> {
    // Each loop is checked once it has run (the first failing index, as
    // when checking every value in turn): no early exit keeps the loops
    // vectorizable, and a failing frame is discarded either way.
    let guide: Vec<f32> = source
        .chunks_exact(3)
        .map(|rgb| libm::log2f((rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2]).max(FLOOR)))
        .collect();
    finite_all(&guide, "guide")?;
    let mean = box_filter(guide.clone(), width, height);
    let denominator = {
        let square: Vec<f32> = guide.iter().map(|v| v * v).collect();
        let mut square_mean = box_filter(square, width, height);
        for (square, mean) in square_mean.iter_mut().zip(&mean) {
            *square = (*square - mean * mean).max(0.0) + epsilon * epsilon;
        }
        finite_all(&square_mean, "variance")?;
        // `square_mean` is no longer needed as such; reuse its allocation
        // for the denominator without changing arithmetic order.
        square_mean
    };

    let mut output = vec![0.0; source.len()];
    for channel in 0..3 {
        let values: Vec<f32> = source.chunks_exact(3).map(|p| p[channel]).collect();
        let products: Vec<f32> = guide.iter().zip(&values).map(|(a, b)| a * b).collect();
        let mut mean_values = box_filter(values, width, height);
        let mut mean_products = box_filter(products, width, height);
        for (((a, b), mean), denominator) in mean_products
            .iter_mut()
            .zip(mean_values.iter_mut())
            .zip(&mean)
            .zip(&denominator)
        {
            *a = (*a - mean * *b) / denominator;
            *b -= *a * mean;
        }
        if let Some(index) = (0..pixels)
            .find(|&index| !mean_products[index].is_finite() || !mean_values[index].is_finite())
        {
            let stage = if mean_products[index].is_finite() {
                "guided-b"
            } else {
                "guided-a"
            };
            return Err(RawChromaError::DerivedNonFinite(stage, index));
        }
        let mean_a = box_filter(mean_products, width, height);
        let mean_b = box_filter(mean_values, width, height);
        for (((pixel, a), b), guide) in output
            .chunks_exact_mut(3)
            .zip(&mean_a)
            .zip(&mean_b)
            .zip(&guide)
        {
            pixel[channel] = a * guide + b;
        }
        if let Some(index) = output
            .chunks_exact(3)
            .position(|pixel| !pixel[channel].is_finite())
        {
            return Err(RawChromaError::DerivedNonFinite("guided-output", index));
        }
    }

    // Preserve source luminance by adding the same signed delta to RGB.
    for (pixel, rgb) in output.chunks_exact_mut(3).zip(source.chunks_exact(3)) {
        let source_y = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
        let filtered_y = pixel[0] * LUMA[0] + pixel[1] * LUMA[1] + pixel[2] * LUMA[2];
        let delta = source_y - filtered_y;
        for value in pixel.iter_mut() {
            *value += delta;
        }
    }
    if let Some(index) = output
        .chunks_exact(3)
        .position(|pixel| pixel.iter().any(|v| !v.is_finite()))
    {
        return Err(RawChromaError::DerivedNonFinite(
            "luminance-projection",
            index,
        ));
    }
    Ok(output)
}

/// The first non-finite value of a stage as its error.
fn finite_all(values: &[f32], stage: &'static str) -> Result<(), RawChromaError> {
    match values.iter().position(|v| !v.is_finite()) {
        Some(index) => Err(RawChromaError::DerivedNonFinite(stage, index)),
        None => Ok(()),
    }
}

/// OpenCV `boxFilter(..., BORDER_REFLECT)` with a normalized 17x17 kernel.
fn box_filter(mut source: Vec<f32>, width: usize, height: usize) -> Vec<f32> {
    // A reflected vertical window spans at most WINDOW consecutive source
    // rows. Their row % WINDOW slots cannot collide while the window uses
    // them (small images just repeat rows). Retain only these horizontal
    // sums instead of an f64 plane for the entire image.
    let mut horizontal = vec![0.0_f64; width * height.min(WINDOW)];
    let mut cached_rows = [usize::MAX; WINDOW];
    for y in 0..height {
        let rows: [usize; WINDOW] = std::array::from_fn(|tap| {
            let sy = reflect(y as isize + tap as isize - RADIUS as isize, height);
            let slot = sy % WINDOW;
            let start = slot * width;
            if cached_rows[slot] != sy {
                horizontal_sums(
                    &source[sy * width..(sy + 1) * width],
                    &mut horizontal[start..start + width],
                );
                cached_rows[slot] = sy;
            }
            start
        });
        let rows = rows.map(|start| &horizontal[start..start + width]);
        // Row y's original horizontal sums have already been cached. They
        // remain cached until every future window needing them has passed,
        // so overwriting this input row cannot affect a later sum
        // (including reflected rows of small images).
        vertical_sums(&rows, &mut source[y * width..(y + 1) * width]);
    }
    source
}

/// One row's horizontal window sums, each in the frozen tap order.
fn horizontal_sums(row: &[f32], out: &mut [f64]) {
    let width = row.len();
    let mut x = 0;
    while x < width {
        // Interior pixels need no reflection or index table. This also
        // avoids width*WINDOW extra storage for very wide, short images.
        // Whole blocks of adjacent outputs go through simd128 / NEON.
        if x >= RADIUS && x + LANES - 1 + RADIUS < width {
            out[x..x + LANES].copy_from_slice(&simd::horizontal(row, x - RADIUS, WINDOW));
            x += LANES;
            continue;
        }
        let mut sum = 0.0;
        if x >= RADIUS && x + RADIUS < width {
            for &value in &row[x - RADIUS..=x + RADIUS] {
                sum += f64::from(value);
            }
        } else {
            for tap in 0..WINDOW {
                let sx = reflect(x as isize + tap as isize - RADIUS as isize, width);
                sum += f64::from(row[sx]);
            }
        }
        out[x] = sum;
        x += 1;
    }
}

/// One output row from the window's cached horizontal sums, each in the
/// frozen tap order.
fn vertical_sums(rows: &[&[f64]; WINDOW], out: &mut [f32]) {
    let width = out.len();
    let complete = width / LANES * LANES;
    for x in (0..complete).step_by(LANES) {
        let sum = simd::vertical(rows, x);
        for (lane, value) in sum.iter().enumerate() {
            out[x + lane] = (value / AREA) as f32;
        }
    }
    for x in complete..width {
        let mut sum = 0.0;
        for row in rows {
            sum += row[x];
        }
        out[x] = (sum / AREA) as f32;
    }
}

fn reflect(position: isize, length: usize) -> usize {
    if length == 1 {
        return 0;
    }
    let n = length as isize;
    let wrapped = position.rem_euclid(2 * n);
    if wrapped < n {
        wrapped as usize
    } else {
        (2 * n - 1 - wrapped) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply_full_reference(source: &[f32], width: usize, height: usize, amount: f64) -> Vec<f32> {
        let pixels = width * height;
        let mut kernel25 = guided(source, width, height, pixels, 0.1).unwrap();
        if amount <= 25.0 {
            let alpha = libm::pow(amount / 25.0, LOW_RANGE_POWER) as f32;
            for (original, filtered) in source.iter().zip(&mut kernel25) {
                *filtered = *original + alpha * (*filtered - *original);
            }
        } else {
            let kernel100 = guided(source, width, height, pixels, 0.4).unwrap();
            let beta = ((amount - 25.0) / 25.0).min(1.0) as f32;
            for (low, high) in kernel25.iter_mut().zip(kernel100) {
                *low = *low + beta * (high - *low);
            }
        }
        kernel25
    }

    #[test]
    fn stripes_preserve_full_image_bits_across_both_filter_passes() {
        let mut seed = 0x1794_5182_u32;
        for (width, height) in [(1, 529), (3, 524), (23, 530), (31, 257), (43, 768)] {
            let source: Vec<f32> = (0..width * height * 3)
                .map(|_| {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    seed as f32 / u32::MAX as f32 * 1.8 - 0.2
                })
                .collect();
            for amount in [1.0, 12.5, 25.0, 37.5, 50.0] {
                let expected = apply_full_reference(&source, width, height, amount);
                let actual = apply(&source, width, height, amount).unwrap();
                for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                    assert_eq!(
                        actual.to_bits(),
                        expected.to_bits(),
                        "{width}x{height}, CNR {amount}, sample {index}"
                    );
                }
            }
        }
    }

    // Frozen full-plane implementation. A sliding sum would change rounding
    // on signed data; the row cache must instead preserve every f32 bit.
    fn box_filter_reference(source: &[f32], width: usize, height: usize) -> Vec<f32> {
        let mut horizontal = vec![0.0_f64; width * height];
        for y in 0..height {
            for x in 0..width {
                let mut sum = 0.0;
                for tap in 0..WINDOW {
                    let sx = reflect(x as isize + tap as isize - RADIUS as isize, width);
                    sum += f64::from(source[y * width + sx]);
                }
                horizontal[y * width + x] = sum;
            }
        }
        let mut output = vec![0.0_f32; width * height];
        for y in 0..height {
            for x in 0..width {
                let mut sum = 0.0;
                for tap in 0..WINDOW {
                    let sy = reflect(y as isize + tap as isize - RADIUS as isize, height);
                    sum += horizontal[sy * width + x];
                }
                output[y * width + x] = (sum / AREA) as f32;
            }
        }
        output
    }

    #[test]
    fn reflected_row_cache_and_input_reuse_preserve_frozen_bits() {
        // Includes singleton axes, windows larger than either dimension,
        // repeated reflections, ring wraparound and high-dynamic-range sums.
        let mut seed = 17515_u32;
        for (width, height) in [
            (1, 1),
            (1, 37),
            (43, 1),
            (3, 2),
            (8, 9),
            (16, 17),
            (17, 16),
            (18, 19),
            (129, 97),
        ]
        .into_iter()
        .chain((1..=40).flat_map(|width| (1..=40).map(move |height| (width, height))))
        {
            let source: Vec<f32> = (0..width * height)
                .map(|i| {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    let sign = seed & 0x8000_0000;
                    let exponent = [90, 117, 127, 137, 160][i % 5] << 23;
                    f32::from_bits(sign | exponent | (seed & 0x007f_ffff))
                })
                .collect();
            let expected = box_filter_reference(&source, width, height);
            let actual = box_filter(source, width, height);
            for (index, (a, b)) in actual.iter().zip(expected).enumerate() {
                assert_eq!(a.to_bits(), b.to_bits(), "{width}x{height} pixel {index}");
            }
        }
    }

    #[test]
    fn a_derived_overflow_names_its_stage_and_first_pixel() {
        // Finite inputs whose guide x value product overflows: every window
        // of this small image holds the bright pixel, so pixel 0's
        // coefficient is the first non-finite value (as when every value
        // was checked in turn, before #17945).
        let mut source = vec![0.25_f32; 5 * 4 * 3];
        source[30..33].copy_from_slice(&[f32::MAX, f32::MAX, f32::MAX]);
        assert!(matches!(
            apply(&source, 5, 4, 25.0),
            Err(RawChromaError::DerivedNonFinite("guided-a", 0))
        ));
    }

    #[test]
    fn zero_is_bit_exact_and_range_is_continuous() {
        let source = vec![-0.1, 0.2, 1.4, 0.4, 0.3, 0.2, 2.1, 0.5, -0.2];
        assert_eq!(apply(&source, 3, 1, 0.0).unwrap(), source);
        let a = apply(&source, 3, 1, 24.999).unwrap();
        let b = apply(&source, 3, 1, 25.0).unwrap();
        assert!(a.iter().zip(b).all(|(x, y)| (*x - y).abs() < 1e-4));
        assert_eq!(
            apply(&source, 3, 1, 50.0).unwrap(),
            apply(&source, 3, 1, 100.0).unwrap()
        );
    }
    #[test]
    fn detail_upper_range_reduces_flat_chroma_and_keeps_frozen_lower_range() {
        // Sensor-like noise is independent per channel, so the log-luma
        // guide carries noise too. A perfectly luma-flat chroma field would
        // make every epsilon collapse to the same box mean (the guide has
        // no variance), which cannot tell the extended range apart.
        let (w, h) = (48, 24);
        let mut seed = 71u32;
        let mut next = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((seed >> 8) as f32 / 16_777_215.0 - 0.5) * 0.12
        };
        let mut source = Vec::with_capacity(w * h * 3);
        for _ in 0..w * h {
            source.extend_from_slice(&[0.3 + next(), 0.3 + next(), 0.3 + next()]);
        }
        for amount in [0.0, 12.5, 25.0, 37.0, 50.0] {
            assert_eq!(
                apply_detail(&source, w, h, amount).unwrap(),
                apply(&source, w, h, amount).unwrap()
            );
        }
        let low = apply_detail(&source, w, h, 50.0).unwrap();
        let high = apply_detail(&source, w, h, 100.0).unwrap();
        let chroma_energy = |pixels: &[f32]| {
            pixels
                .chunks_exact(3)
                .map(|p| (p[0] - p[1]).powi(2) + (p[2] - p[1]).powi(2))
                .sum::<f32>()
        };
        let (source_energy, low_energy, high_energy) = (
            chroma_energy(&source),
            chroma_energy(&low),
            chroma_energy(&high),
        );
        assert!(
            high_energy < low_energy * 0.9,
            "100 must reduce more chroma than 50: {high_energy} vs {low_energy}"
        );
        assert!(low_energy < source_energy);
        for (pixel, original) in high.chunks_exact(3).zip(source.chunks_exact(3)) {
            let y = pixel[0] * LUMA[0] + pixel[1] * LUMA[1] + pixel[2] * LUMA[2];
            let source_y = original[0] * LUMA[0] + original[1] * LUMA[1] + original[2] * LUMA[2];
            assert!((y - source_y).abs() < 2e-5, "luma drift {y} vs {source_y}");
        }
    }
}
