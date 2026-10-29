//! Downscaling in linear light: separable Lanczos-3 (anti-aliased, support
//! scaled by the reduction, edge pixels extended like Core Image's
//! `clampedToExtent` + `CILanczosScaleTransform`) or area average. Rows are
//! pulled from a source on demand and only a window of horizontally
//! filtered rows is kept, so a 24 MP original never needs a full-size
//! `f32` copy.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    Lanczos3,
    Area,
}

/// Per output sample: first input index and weights (sum 1).
struct Taps {
    start: Vec<usize>,
    weights: Vec<Vec<f32>>,
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        let px = core::f64::consts::PI * x;
        libm::sin(px) / px
    }
}

fn lanczos3(x: f64) -> f64 {
    if x.abs() >= 3.0 {
        0.0
    } else {
        sinc(x) * sinc(x / 3.0)
    }
}

fn make_taps(in_n: usize, out_n: usize, filter: Filter) -> Taps {
    let scale = out_n as f64 / in_n as f64;
    let mut start = Vec::with_capacity(out_n);
    let mut weights = Vec::with_capacity(out_n);
    for o in 0..out_n {
        let (first, w): (isize, Vec<f64>) = match filter {
            Filter::Lanczos3 => {
                let center = (o as f64 + 0.5) / scale - 0.5;
                let support = 3.0 / scale.min(1.0);
                let first = libm::floor(center - support) as isize + 1;
                let last = libm::ceil(center + support) as isize - 1;
                let w = (first..=last)
                    .map(|i| lanczos3((i as f64 - center) * scale.min(1.0)))
                    .collect();
                (first, w)
            }
            Filter::Area => {
                let x0 = o as f64 / scale;
                let x1 = (o + 1) as f64 / scale;
                let first = libm::floor(x0) as isize;
                let last = (libm::ceil(x1) as isize - 1).max(first);
                let w = (first..=last)
                    .map(|i| {
                        let a = (i as f64).max(x0);
                        let b = ((i + 1) as f64).min(x1);
                        (b - a).max(0.0)
                    })
                    .collect();
                (first, w)
            }
        };
        // Clamp to the edge: fold out-of-range taps onto the border pixels.
        let lo = first.max(0) as usize;
        let hi = ((first + w.len() as isize - 1).min(in_n as isize - 1)).max(lo as isize) as usize;
        let mut folded = vec![0.0f64; hi - lo + 1];
        for (k, weight) in w.iter().enumerate() {
            let i = (first + k as isize).clamp(0, in_n as isize - 1) as usize;
            folded[i - lo] += weight;
        }
        let sum: f64 = folded.iter().sum();
        let norm = if sum.abs() > 1e-12 { 1.0 / sum } else { 1.0 };
        start.push(lo);
        weights.push(folded.iter().map(|v| (v * norm) as f32).collect());
    }
    Taps { start, weights }
}

/// Output size fitting `max_dimension` on the long edge (never enlarges);
/// rounds like Core Image's integral extent (`ceil` of the scaled size,
/// but not above the exact long edge).
pub fn fitted_size(width: usize, height: usize, max_dimension: usize) -> (usize, usize) {
    let long = width.max(height);
    if long <= max_dimension || max_dimension == 0 {
        return (width, height);
    }
    let scale = max_dimension as f64 / long as f64;
    let w = if width >= height {
        max_dimension
    } else {
        (libm::round(width as f64 * scale) as usize).max(1)
    };
    let h = if height > width {
        max_dimension
    } else {
        (libm::round(height as f64 * scale) as usize).max(1)
    };
    (w, h)
}

/// Resamples an interleaved RGB image of `in_w x in_h` whose rows come from
/// `row(y, out)` (fills `in_w * 3` linear values) into `out_w x out_h`.
pub fn resample_rows(
    in_w: usize,
    in_h: usize,
    out_w: usize,
    out_h: usize,
    filter: Filter,
    mut row: impl FnMut(usize, &mut [f32]),
) -> Vec<f32> {
    let mut whole = Vec::new();
    resample_window(
        in_w,
        in_h,
        out_w,
        out_h,
        filter,
        0..out_w,
        0..out_h,
        |y, first, out| {
            if first == 0 && out.len() == in_w * 3 {
                row(y, out);
            } else {
                whole.resize(in_w * 3, 0.0);
                row(y, &mut whole);
                out.copy_from_slice(&whole[first * 3..first * 3 + out.len()]);
            }
        },
    )
}

/// The rows `rows` and columns `columns` of the `out_w x out_h` reduction
/// of [`resample_rows`], bit for bit (the same taps and the same order of
/// the sums), reading only the input the window needs: `row(y, first, out)`
/// fills `out.len() / 3` pixels of input row `y` starting at column
/// `first`, and rows above the window's first tap are not requested.
/// Returns `columns.len() x rows.len()` interleaved RGB.
#[allow(clippy::too_many_arguments)]
pub fn resample_window(
    in_w: usize,
    in_h: usize,
    out_w: usize,
    out_h: usize,
    filter: Filter,
    columns: std::ops::Range<usize>,
    rows: std::ops::Range<usize>,
    row: impl FnMut(usize, usize, &mut [f32]),
) -> Vec<f32> {
    let mut out = vec![0.0f32; columns.len() * rows.len() * 3];
    if columns.is_empty() || rows.is_empty() {
        return out;
    }
    let h_taps = make_taps(in_w, out_w, filter);
    let v_taps = make_taps(in_h, out_h, filter);
    window_into(&h_taps, &v_taps, columns, rows, row, &mut out);
    out
}

/// [`resample_window`] with its taps, into `out` (`columns.len() x
/// rows.len()` RGB, zeros).
fn window_into(
    h_taps: &Taps,
    v_taps: &Taps,
    columns: std::ops::Range<usize>,
    rows: std::ops::Range<usize>,
    mut row: impl FnMut(usize, usize, &mut [f32]),
    out: &mut [f32],
) {
    let window_w = columns.len();
    let first_column = columns.clone().map(|x| h_taps.start[x]).min().unwrap_or(0);
    let end_column = columns
        .clone()
        .map(|x| h_taps.start[x] + h_taps.weights[x].len())
        .max()
        .unwrap_or(0);
    let mut input_row = vec![0.0f32; (end_column - first_column) * 3];
    // Window of horizontally filtered rows, keyed by input row.
    let mut cache: std::collections::VecDeque<(usize, Vec<f32>)> =
        std::collections::VecDeque::new();
    let mut next_row = v_taps.start[rows.start];
    for oy in rows.clone() {
        let first = v_taps.start[oy];
        let count = v_taps.weights[oy].len();
        while let Some((y, _)) = cache.front() {
            if *y < first {
                cache.pop_front();
            } else {
                break;
            }
        }
        // Rows between two outputs' taps (none with these filters) are
        // not needed.
        next_row = next_row.max(first);
        while next_row < first + count {
            row(next_row, first_column, &mut input_row);
            let mut filtered = vec![0.0f32; window_w * 3];
            for (ox, px) in columns.clone().zip(filtered.chunks_exact_mut(3)) {
                let s = h_taps.start[ox] - first_column;
                let (mut r, mut g, mut b) = (0.0f32, 0.0f32, 0.0f32);
                for (k, w) in h_taps.weights[ox].iter().enumerate() {
                    let i = (s + k) * 3;
                    r += w * input_row[i];
                    g += w * input_row[i + 1];
                    b += w * input_row[i + 2];
                }
                px[0] = r;
                px[1] = g;
                px[2] = b;
            }
            cache.push_back((next_row, filtered));
            next_row += 1;
        }
        let dst = &mut out[(oy - rows.start) * window_w * 3..(oy - rows.start + 1) * window_w * 3];
        for (k, w) in v_taps.weights[oy].iter().enumerate() {
            let y = first + k;
            let src = &cache
                .iter()
                .find(|(ry, _)| *ry == y)
                .expect("row in window")
                .1;
            for (d, s) in dst.iter_mut().zip(src.iter()) {
                *d += w * s;
            }
        }
    }
}

/// Resamples an in-memory interleaved RGB image.
pub fn resample(
    src: &[f32],
    in_w: usize,
    in_h: usize,
    out_w: usize,
    out_h: usize,
    filter: Filter,
) -> Vec<f32> {
    if in_w == out_w && in_h == out_h {
        return src.to_vec();
    }
    let mut out = vec![0.0f32; out_w * out_h * 3];
    let h_taps = make_taps(in_w, out_w, filter);
    let v_taps = make_taps(in_h, out_h, filter);
    // Bands of output rows, each filtering the input rows its window needs
    // (the same taps and order of the sums as one window over all rows,
    // [`resample_window`]), so the bands may run on different threads
    // (#150).
    crate::par::for_each_band_mut(&mut out, out_w * 3, |first, band| {
        let rows = first..first + band.len() / (out_w * 3);
        window_into(
            &h_taps,
            &v_taps,
            0..out_w,
            rows,
            |y, first_column, input| {
                let start = (y * in_w + first_column) * 3;
                input.copy_from_slice(&src[start..start + input.len()]);
            },
            band,
        );
    });
    out
}

/// Core Image `CIImage.transformed(by: scale)` sampling (bilinear at the
/// scaled pixel centers, edges clamped): what Photo Bench's adaptive
/// statistics read. `long_edge` is the target long edge; never enlarges.
pub fn bilinear_downscale(
    src: &[f32],
    in_w: usize,
    in_h: usize,
    long_edge: f64,
) -> (Vec<f32>, usize, usize) {
    bilinear_downscale_with(src, in_w, in_h, long_edge, |px| px)
}

/// [`bilinear_downscale`] of `map(pixel)`: `map` runs on each sampled
/// source pixel before the interpolation, so the result equals reducing a
/// mapped copy of the image without making that copy.
pub fn bilinear_downscale_with(
    src: &[f32],
    in_w: usize,
    in_h: usize,
    long_edge: f64,
    map: impl Fn([f32; 3]) -> [f32; 3],
) -> (Vec<f32>, usize, usize) {
    let pixel = |i: usize| map([src[i * 3], src[i * 3 + 1], src[i * 3 + 2]]);
    let long = in_w.max(in_h) as f64;
    let scale = (long_edge / long).min(1.0);
    if scale >= 1.0 {
        let mut out = Vec::with_capacity(in_w * in_h * 3);
        for i in 0..in_w * in_h {
            out.extend_from_slice(&pixel(i));
        }
        return (out, in_w, in_h);
    }
    let out_w = (libm::ceil(in_w as f64 * scale) as usize).max(1);
    let out_h = (libm::ceil(in_h as f64 * scale) as usize).max(1);
    let mut out = vec![0.0f32; out_w * out_h * 3];
    for oy in 0..out_h {
        let sy = ((oy as f64 + 0.5) / scale - 0.5).clamp(0.0, (in_h - 1) as f64);
        let y0 = libm::floor(sy) as usize;
        let y1 = (y0 + 1).min(in_h - 1);
        let ty = (sy - y0 as f64) as f32;
        for ox in 0..out_w {
            let sx = ((ox as f64 + 0.5) / scale - 0.5).clamp(0.0, (in_w - 1) as f64);
            let x0 = libm::floor(sx) as usize;
            let x1 = (x0 + 1).min(in_w - 1);
            let tx = (sx - x0 as f64) as f32;
            let p00 = pixel(y0 * in_w + x0);
            let p10 = pixel(y0 * in_w + x1);
            let p01 = pixel(y1 * in_w + x0);
            let p11 = pixel(y1 * in_w + x1);
            for c in 0..3 {
                let top = p00[c] + (p10[c] - p00[c]) * tx;
                let bottom = p01[c] + (p11[c] - p01[c]) * tx;
                out[(oy * out_w + ox) * 3 + c] = top + (bottom - top) * ty;
            }
        }
    }
    (out, out_w, out_h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fitted_size_keeps_aspect() {
        assert_eq!(fitted_size(6000, 4000, 2560), (2560, 1707));
        assert_eq!(fitted_size(4000, 6000, 2560), (1707, 2560));
        assert_eq!(fitted_size(800, 600, 2560), (800, 600));
    }

    #[test]
    fn a_window_is_the_whole_reduction_bit_for_bit() {
        let (w, h) = (97usize, 61usize);
        let src: Vec<f32> = (0..w * h * 3)
            .map(|i| ((i * 7919) % 1000) as f32 / 997.0 + (i % 3) as f32 * 0.1)
            .collect();
        for filter in [Filter::Lanczos3, Filter::Area] {
            // Reduced, and the same size (taps at scale 1, not a copy).
            for (ow, oh) in [(40usize, 25usize), (97, 61), (60, 61)] {
                let whole = resample_rows(w, h, ow, oh, filter, |y, out| {
                    out.copy_from_slice(&src[y * w * 3..(y + 1) * w * 3]);
                });
                for (xs, ys) in [
                    (0..ow, 0..oh),
                    (3..17, 5..9),
                    (ow - 7..ow, 0..3),
                    (0..1, oh - 1..oh),
                ] {
                    let mut first_row = None;
                    let window = resample_window(
                        w,
                        h,
                        ow,
                        oh,
                        filter,
                        xs.clone(),
                        ys.clone(),
                        |y, first, out| {
                            first_row.get_or_insert(y);
                            let n = out.len();
                            out.copy_from_slice(&src[(y * w + first) * 3..(y * w + first) * 3 + n]);
                        },
                    );
                    let expected: Vec<f32> = ys
                        .clone()
                        .flat_map(|y| {
                            whole[(y * ow + xs.start) * 3..(y * ow + xs.end) * 3].to_vec()
                        })
                        .collect();
                    let same = window
                        .iter()
                        .zip(&expected)
                        .all(|(a, b)| a.to_bits() == b.to_bits());
                    assert!(
                        same && window.len() == expected.len(),
                        "{filter:?} {ow}x{oh} {xs:?} {ys:?}"
                    );
                    // No input row above the window's first tap is read.
                    if ys.start > 3 && ow < w {
                        assert!(first_row.unwrap() > 0, "{filter:?} {xs:?} {ys:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn constant_image_stays_constant() {
        let src = vec![0.25f32; 97 * 61 * 3];
        for filter in [Filter::Lanczos3, Filter::Area] {
            let out = resample(&src, 97, 61, 40, 25, filter);
            assert_eq!(out.len(), 40 * 25 * 3);
            for v in out {
                assert!((v - 0.25).abs() < 1e-5);
            }
        }
    }
}
