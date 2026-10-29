//! NIHO 5: bounded reconstruction of featureless signed-RAW highlights.
//!
//! The signed working-copy ceiling is the only input scale. The ceiling is a
//! power-of-two storage bound, so a clipped plateau can sit below it; a PNG
//! code of 65535 is not a sensor-white test. We use a soft high-value and
//! low-chroma mask, carry nearby unclipped chroma into that mask at a small
//! fixed analysis size, and compress the plateau's luminance. This is a
//! stage-2 operation and does not inspect the RAW decoder or camera model.

use crate::color::PP_LUMA_F32;
use crate::resize::{self, Filter};

const ANALYSIS_EDGE: usize = 320;
const PROPAGATION_STEPS: usize = 24;
const BRIGHT_START: f32 = 0.42;
const BRIGHT_FULL: f32 = 0.52;
const CHROMA_START: f32 = 0.02;
const CHROMA_END: f32 = 0.10;
const FLAT_START: f32 = 0.0005;
const FLAT_END: f32 = 0.005;
const SHOULDER_STRENGTH: f32 = 0.04;
const CHROMA_STRENGTH: f32 = 0.18;

fn smoothstep(low: f32, high: f32, value: f32) -> f32 {
    let t = ((value - low) / (high - low)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn clip_weight(pixel: &[f32], ceiling: f32) -> f32 {
    let max = pixel[0].max(pixel[1]).max(pixel[2]);
    let min = pixel[0].min(pixel[1]).min(pixel[2]);
    let brightness = smoothstep(BRIGHT_START, BRIGHT_FULL, max / ceiling);
    let neutrality = 1.0 - smoothstep(CHROMA_START, CHROMA_END, (max - min) / ceiling);
    brightness * neutrality
}

fn plateau_weight(data: &[f32], width: usize, height: usize, index: usize, ceiling: f32) -> f32 {
    let x = index % width;
    let y = index / width;
    let pixel = &data[index * 3..index * 3 + 3];
    let neighbors = [
        (x > 0).then_some(index.wrapping_sub(1)),
        (x + 1 < width).then_some(index + 1),
        (y > 0).then_some(index.wrapping_sub(width)),
        (y + 1 < height).then_some(index + width),
    ];
    let mut smallest = f32::INFINITY;
    for neighbor in neighbors.into_iter().flatten() {
        let other = &data[neighbor * 3..neighbor * 3 + 3];
        let difference = (0..3)
            .map(|channel| (pixel[channel] - other[channel]).abs())
            .fold(0.0_f32, f32::max);
        smallest = smallest.min(difference);
    }
    if !smallest.is_finite() {
        return 0.0;
    }
    1.0 - smoothstep(FLAT_START, FLAT_END, smallest / ceiling)
}

fn mask_weight(data: &[f32], width: usize, height: usize, index: usize, ceiling: f32) -> f32 {
    clip_weight(&data[index * 3..index * 3 + 3], ceiling)
        * plateau_weight(data, width, height, index, ceiling)
}

/// The existing NIHO 5 soft detection mask evaluated without mutating its
/// signed source. NIHO 7 uses this full-source result only for the non-FX
/// R23 residual; NIHO 5 reconstruction remains unchanged.
pub(crate) fn mask_weights(data: &[f32], width: usize, height: usize, ceiling: f32) -> Vec<f32> {
    let mut weights = vec![0.0; width * height];
    // Each weight reads the unchanged source only, so rows may run on
    // different threads (#150).
    crate::par::for_each_row_mut(&mut weights, width, |y, row| {
        for (x, weight) in row.iter_mut().enumerate() {
            *weight = mask_weight(data, width, height, y * width + x, ceiling);
        }
    });
    weights
}

fn luminance(pixel: &[f32]) -> f32 {
    pixel[0] * PP_LUMA_F32[0] + pixel[1] * PP_LUMA_F32[1] + pixel[2] * PP_LUMA_F32[2]
}

fn propagated_chroma(
    data: &[f32],
    width: usize,
    height: usize,
    ceiling: f32,
) -> (Vec<[f32; 3]>, Vec<f32>, usize, usize) {
    let (small_w, small_h) = resize::fitted_size(width, height, ANALYSIS_EDGE);
    let small = if (small_w, small_h) == (width, height) {
        data.to_vec()
    } else {
        resize::resample(data, width, height, small_w, small_h, Filter::Lanczos3)
    };
    let count = small_w * small_h;
    let mut chroma = vec![[0.0; 3]; count];
    let mut mask = vec![0.0; count];
    let mut known = vec![false; count];
    let mut masked = vec![false; count];
    for (i, pixel) in small.chunks_exact(3).enumerate() {
        let weight = mask_weight(&small, small_w, small_h, i, ceiling);
        mask[i] = weight;
        masked[i] = weight > 0.5;
        if !masked[i] {
            let y = luminance(pixel);
            if y > ceiling * 0.08
                && pixel.iter().copied().fold(f32::NEG_INFINITY, f32::max) > ceiling * 0.16
            {
                for channel in 0..3 {
                    chroma[i][channel] = (pixel[channel] / y - 1.0).clamp(-0.5, 0.5);
                }
                known[i] = true;
            }
        }
    }

    // A bounded front moves chroma only through the suspected clipped area.
    // Its finite reach leaves an uninformative large white center neutral.
    for _ in 0..PROPAGATION_STEPS {
        let mut next = Vec::new();
        for i in 0..count {
            if !masked[i] || known[i] {
                continue;
            }
            let x = i % small_w;
            let y = i / small_w;
            let neighbors = [
                (x > 0).then_some(i.wrapping_sub(1)),
                (x + 1 < small_w).then_some(i + 1),
                (y > 0).then_some(i.wrapping_sub(small_w)),
                (y + 1 < small_h).then_some(i + small_w),
            ];
            let mut sum = [0.0_f32; 3];
            let mut n = 0.0_f32;
            for neighbor in neighbors.into_iter().flatten() {
                if known[neighbor] {
                    for channel in 0..3 {
                        sum[channel] += chroma[neighbor][channel];
                    }
                    n += 1.0;
                }
            }
            if n > 0.0 {
                next.push((i, [sum[0] / n, sum[1] / n, sum[2] / n]));
            }
        }
        if next.is_empty() {
            break;
        }
        for (i, value) in next {
            chroma[i] = value;
            known[i] = true;
        }
    }
    for i in 0..count {
        if !masked[i] {
            chroma[i] = [0.0; 3];
        }
    }
    (chroma, mask, small_w, small_h)
}

fn sample(
    chroma: &[[f32; 3]],
    small_w: usize,
    small_h: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> [f32; 3] {
    let sx =
        ((x as f32 + 0.5) * small_w as f32 / width as f32 - 0.5).clamp(0.0, (small_w - 1) as f32);
    let sy =
        ((y as f32 + 0.5) * small_h as f32 / height as f32 - 0.5).clamp(0.0, (small_h - 1) as f32);
    let x0 = sx as usize;
    let y0 = sy as usize;
    let x1 = (x0 + 1).min(small_w - 1);
    let y1 = (y0 + 1).min(small_h - 1);
    let ax = sx - x0 as f32;
    let ay = sy - y0 as f32;
    let mut out = [0.0; 3];
    for channel in 0..3 {
        let a = chroma[y0 * small_w + x0][channel] * (1.0 - ax)
            + chroma[y0 * small_w + x1][channel] * ax;
        let b = chroma[y1 * small_w + x0][channel] * (1.0 - ax)
            + chroma[y1 * small_w + x1][channel] * ax;
        out[channel] = a * (1.0 - ay) + b * ay;
    }
    out
}

fn sample_mask(
    mask: &[f32],
    small_w: usize,
    small_h: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> f32 {
    let sx =
        ((x as f32 + 0.5) * small_w as f32 / width as f32 - 0.5).clamp(0.0, (small_w - 1) as f32);
    let sy =
        ((y as f32 + 0.5) * small_h as f32 / height as f32 - 0.5).clamp(0.0, (small_h - 1) as f32);
    let x0 = sx as usize;
    let y0 = sy as usize;
    let x1 = (x0 + 1).min(small_w - 1);
    let y1 = (y0 + 1).min(small_h - 1);
    let ax = sx - x0 as f32;
    let ay = sy - y0 as f32;
    let a = mask[y0 * small_w + x0] * (1.0 - ax) + mask[y0 * small_w + x1] * ax;
    let b = mask[y1 * small_w + x0] * (1.0 - ax) + mask[y1 * small_w + x1] * ax;
    a * (1.0 - ay) + b * ay
}

pub(crate) fn apply(data: &mut [f32], width: usize, height: usize, ceiling: f32, amount: f32) {
    if amount <= 0.0
        || !amount.is_finite()
        || !ceiling.is_finite()
        || ceiling <= 0.0
        || width == 0
        || height == 0
        || width.checked_mul(height).and_then(|n| n.checked_mul(3)) != Some(data.len())
    {
        return;
    }
    if !(0..width * height).any(|i| mask_weight(data, width, height, i, ceiling) > 0.0) {
        return;
    }
    let (chroma, mask, small_w, small_h) = propagated_chroma(data, width, height, ceiling);
    // Each pixel reads only itself and the small maps, so rows may run on
    // different threads (#150).
    crate::par::for_each_row_mut(data, width * 3, |y_pos, row| {
        for (x, pixel) in row.chunks_exact_mut(3).enumerate() {
            let weight = clip_weight(pixel, ceiling)
                * sample_mask(&mask, small_w, small_h, x, y_pos, width, height)
                * amount;
            if weight <= 0.0 {
                continue;
            }
            let y = luminance(pixel).max(0.0);
            let carried = sample(&chroma, small_w, small_h, x, y_pos, width, height);
            let shoulder = 1.0 - SHOULDER_STRENGTH * weight;
            for channel in 0..3 {
                pixel[channel] =
                    pixel[channel] * shoulder + y * CHROMA_STRENGTH * weight * carried[channel];
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipped_neutral_plateau_receives_neighbor_chroma_and_a_luminance_shoulder() {
        let (width, height) = (64, 48);
        let mut data = vec![0.0; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let pixel = &mut data[(y * width + x) * 3..][..3];
                pixel.copy_from_slice(if (12..52).contains(&x) && (10..38).contains(&y) {
                    &[2.06, 2.06, 2.06]
                } else {
                    &[0.65, 0.79, 1.12]
                });
            }
        }
        let original = data.clone();
        apply(&mut data, width, height, 4.0, 0.0);
        assert_eq!(data, original);
        apply(&mut data, width, height, 4.0, 1.0);
        let edge = &data[(24 * width + 13) * 3..][..3];
        assert!(edge[0] < 2.06 && edge[2] > edge[0]);
        // 左上（x=0, y=0）はクリップの外なので変わらない
        assert_eq!(&data[..3], &[0.65, 0.79, 1.12]);
    }

    #[test]
    fn values_below_the_ceiling_relative_mask_remain_exact() {
        let mut data = vec![0.2, 0.3, 0.4, -0.1, 0.1, 0.2];
        let original = data.clone();
        apply(&mut data, 2, 1, 4.0, 1.0);
        assert_eq!(data, original);
    }

    #[test]
    fn immutable_mask_rejects_negative_and_non_bright_pixels() {
        let data = vec![-0.4, -0.2, -0.1, 0.2, 0.3, 0.4];
        assert_eq!(mask_weights(&data, 2, 1, 4.0), vec![0.0, 0.0]);
    }
}
