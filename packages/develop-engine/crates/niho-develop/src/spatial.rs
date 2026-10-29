//! Highlights2012 / Shadows2012 / Texture / Clarity2012: a port of Photo
//! Bench `SpatialToneOps.swift` (the CPU reference, itself a 1:1 port of
//! `spatial_model_v2.py` and `detail_model.py`) in `f32`.
//!
//! - Burt–Adelson 5-tap pyramid with numpy `reflect` borders.
//! - Highlights: identity remap (fast path), gain curve added to the coarsest
//!   Gaussian level (`levelsH = round(log2(scalePx))`).
//! - Shadows: fast local Laplacian (Paris–Hasinoff–Kautz remap, Aubry
//!   discretization with `nDisc` = 10 final / 5 interactive), `levelsH - 3`.
//! - Texture / Clarity: per-level multiplicative gains (`levelsH` / `+3`).
//! - One final ratio `2^(Ln_final - Ln0)` on RGB (hue/saturation kept).
//!
//! The image-adaptive amplitude/shift laws (`SpatialAdaptiveLaw`) and their
//! statistics (`SpatialAdaptiveStats`) are ported with Photo Bench's
//! production defaults (RAW `shift-refit`, non-RAW the adopted law); the
//! experiment-only environment switches are not.

use crate::color::PP_LUMA_F32;

/// A `width x height` single-channel plane.
#[derive(Debug, Clone)]
pub struct Plane {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

impl Plane {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            data: vec![0.0; width * height],
        }
    }
}

/// `SpatialToneQuality`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
    Interactive,
    Final,
}

impl Quality {
    pub fn shadows_discretization(self) -> usize {
        match self {
            Quality::Interactive => 5,
            Quality::Final => 10,
        }
    }

    /// `AdobeBaseRenderer.highlightRatioBaseLongEdge(for:)`.
    pub fn stats_long_edge(self) -> f64 {
        match self {
            Quality::Interactive => 375.0,
            Quality::Final => 750.0,
        }
    }
}

/// `SpatialToneOps.scalePx(forLongEdge:)`.
pub fn scale_px(long_edge: f64) -> f64 {
    32.0 * (long_edge / 1500.0)
}

/// `max(1, round_half_even(log2(max(scalePx, 2))))`.
pub fn levels_for_scale(scale_px: f64) -> usize {
    let l = libm::log2(scale_px.max(2.0)).round_ties_even();
    (l as i64).max(1) as usize
}

const EPS: f32 = 3e-5;
const BINOM5: [f32; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];

/// numpy `reflect` index mapping (period `2(n-1)`; `n <= 1` maps to 0).
#[inline]
pub fn reflect_index(i: isize, n: usize) -> usize {
    if n <= 1 {
        return 0;
    }
    let period = 2 * (n as isize - 1);
    let mut r = i % period;
    if r < 0 {
        r += period;
    }
    if r < n as isize {
        r as usize
    } else {
        (period - r) as usize
    }
}

/// `_pyr_down`: blur5 (vertical then horizontal), keep even rows/columns.
/// Only the kept samples are computed (identical values), one vertically
/// blurred row at a time (no half-height intermediate plane).
pub fn pyr_down(p: &Plane) -> Plane {
    let out_w = p.width.div_ceil(2);
    let out_h = p.height.div_ceil(2);
    let cols: Vec<[usize; 5]> = (0..out_w)
        .map(|ox| {
            core::array::from_fn(|k| reflect_index(2 * ox as isize + k as isize - 2, p.width))
        })
        .collect();
    let mut out = Plane::new(out_w, out_h);
    // Output rows read only `p`, so they may run on different threads, each
    // filling its own blurred row (#150).
    crate::par::for_each_row_mut_with(
        &mut out.data,
        out_w,
        || vec![0.0f32; p.width],
        |row, oy, dst| {
            // Vertical blur of the even row `2 * oy`, all columns.
            let y = 2 * oy as isize;
            let src: [usize; 5] =
                core::array::from_fn(|k| reflect_index(y + k as isize - 2, p.height));
            let r0 = &p.data[src[0] * p.width..(src[0] + 1) * p.width];
            let r1 = &p.data[src[1] * p.width..(src[1] + 1) * p.width];
            let r2 = &p.data[src[2] * p.width..(src[2] + 1) * p.width];
            let r3 = &p.data[src[3] * p.width..(src[3] + 1) * p.width];
            let r4 = &p.data[src[4] * p.width..(src[4] + 1) * p.width];
            for x in 0..p.width {
                row[x] = BINOM5[0] * r0[x]
                    + BINOM5[1] * r1[x]
                    + BINOM5[2] * r2[x]
                    + BINOM5[3] * r3[x]
                    + BINOM5[4] * r4[x];
            }
            // Horizontal blur at even columns.
            for (d, c) in dst.iter_mut().zip(cols.iter()) {
                *d = BINOM5[0] * row[c[0]]
                    + BINOM5[1] * row[c[1]]
                    + BINOM5[2] * row[c[2]]
                    + BINOM5[3] * row[c[3]]
                    + BINOM5[4] * row[c[4]];
            }
        },
    );
    out
}

/// Per output column of `pyr_up`, the contributing even source columns of
/// the zero-inserted row and their weights, in kernel order.
struct UpTaps {
    /// `offsets[x]..offsets[x + 1]` indexes `taps`.
    offsets: Vec<u32>,
    taps: Vec<(u32, f32)>,
}

impl UpTaps {
    fn new(in_w: usize, out_w: usize) -> Self {
        let w2 = in_w * 2;
        let mut offsets = Vec::with_capacity(out_w + 1);
        let mut taps = Vec::with_capacity(out_w * 3);
        offsets.push(0);
        for x in 0..out_w {
            for (k, weight) in BINOM5.iter().enumerate() {
                let sx = reflect_index(x as isize + k as isize - 2, w2.max(1));
                if sx % 2 == 0 {
                    taps.push(((sx / 2) as u32, *weight));
                }
            }
            offsets.push(taps.len() as u32);
        }
        Self { offsets, taps }
    }
}

/// `_pyr_up` (zero-insert to `2w x 2h`, blur5 x4, crop to `out_w x out_h`)
/// one output row at a time: `emit(y, row)` receives exactly the values
/// [`pyr_up`] stores, so callers can consume them (subtract, add) without a
/// full-size buffer. The zero samples are skipped (identical values).
pub fn pyr_up_rows(p: &Plane, out_w: usize, out_h: usize, mut emit: impl FnMut(usize, &[f32])) {
    let taps = UpTaps::new(p.width, out_w);
    let mut tmp = vec![0.0f32; p.width];
    let mut row = vec![0.0f32; out_w];
    for y in 0..out_h {
        up_row(p, &taps, y, &mut tmp, &mut row);
        emit(y, &row);
    }
}

/// Row `y` of [`pyr_up_rows`] into `row` (`tmp`: `p.width` values, filled
/// here).
#[inline]
fn up_row(p: &Plane, taps: &UpTaps, y: usize, tmp: &mut [f32], row: &mut [f32]) {
    let h2 = p.height * 2;
    // Vertical pass over the zero-inserted image's even columns only (odd
    // columns are all zero), then the horizontal taps.
    tmp.fill(0.0);
    for (k, w) in BINOM5.iter().enumerate() {
        let sy = reflect_index(y as isize + k as isize - 2, h2.max(1));
        if sy % 2 != 0 || h2 == 0 {
            continue;
        }
        let src = &p.data[(sy / 2) * p.width..(sy / 2 + 1) * p.width];
        for (d, v) in tmp.iter_mut().zip(src.iter()) {
            *d += w * v;
        }
    }
    for (x, dst) in row.iter_mut().enumerate() {
        let mut sum = 0.0f32;
        for (sx, w) in &taps.taps[taps.offsets[x] as usize..taps.offsets[x + 1] as usize] {
            sum += w * tmp[*sx as usize];
        }
        *dst = sum * 4.0;
    }
}

/// [`pyr_up_rows`] consumed by the rows of `dst` (`out_w` long):
/// `f(y, dst_row, up_row)`. Each row reads only `p` and writes only its own
/// row of `dst` (callers read their other planes at the same row), so rows
/// may run on different threads, each with its own row buffers (#150).
fn pyr_up_each_row(
    p: &Plane,
    dst: &mut [f32],
    out_w: usize,
    f: impl Fn(usize, &mut [f32], &[f32]) + Sync + Send,
) {
    let taps = UpTaps::new(p.width, out_w);
    crate::par::for_each_row_mut_with(
        dst,
        out_w,
        || (vec![0.0f32; p.width], vec![0.0f32; out_w]),
        |(tmp, row), y, dst_row| {
            up_row(p, &taps, y, tmp, row);
            f(y, dst_row, &row[..]);
        },
    );
}

/// `_pyr_up`: zero-insert to `2w x 2h`, blur5 x4, crop to `out_w x out_h`.
pub fn pyr_up(p: &Plane, out_w: usize, out_h: usize) -> Plane {
    let mut out = Plane::new(out_w, out_h);
    pyr_up_each_row(p, &mut out.data, out_w, |_, dst, row| {
        dst.copy_from_slice(row);
    });
    out
}

/// `dst += pyr_up(src)` without the full-size upsampled plane (the sum is
/// commutative, so this equals the reference's `pyr_up(src) + dst`).
fn add_pyr_up(src: &Plane, dst: &mut Plane) {
    let w = dst.width;
    pyr_up_each_row(src, &mut dst.data, w, |_, dst, row| {
        for (d, u) in dst.iter_mut().zip(row) {
            *d += u;
        }
    });
}

/// Levels `1..=levels` of the Gaussian pyramid of `x` (level 0 is `x`).
fn gaussian_levels(x: &Plane, levels: usize) -> Vec<Plane> {
    let mut g: Vec<Plane> = Vec::with_capacity(levels);
    for l in 0..levels {
        let next = pyr_down(if l == 0 { x } else { &g[l - 1] });
        g.push(next);
    }
    g
}

pub fn gaussian_pyramid(x: &Plane, levels: usize) -> Vec<Plane> {
    let mut g = Vec::with_capacity(levels + 1);
    g.push(x.clone());
    g.extend(gaussian_levels(x, levels));
    g
}

/// `lap[i] = G[i] - pyrUp(G[i+1])`, `lap[last] = G[last]`.
pub fn laplacian_pyramid(g: &[Plane]) -> Vec<Plane> {
    let mut lap = Vec::with_capacity(g.len());
    for i in 0..g.len() - 1 {
        let mut level = g[i].clone();
        let w = level.width;
        pyr_up_each_row(&g[i + 1], &mut level.data, w, |_, dst, row| {
            for (d, u) in dst.iter_mut().zip(row) {
                *d -= u;
            }
        });
        lap.push(level);
    }
    lap.push(g[g.len() - 1].clone());
    lap
}

pub fn reconstruct(lap: &[Plane]) -> Plane {
    let mut levels = lap.to_vec();
    for i in (0..levels.len() - 1).rev() {
        let (lo, hi) = levels.split_at_mut(i + 1);
        add_pyr_up(&hi[0], &mut lo[i]);
    }
    levels.swap_remove(0)
}

// MARK: - Gain curves (verbatim `GAIN_TABLE_100` / `GAIN_TABLE_50`)

fn grid(i: usize) -> f64 {
    -14.0 + i as f64 * 0.5
}

#[rustfmt::skip]
const GAIN100_H_NEG: [f64; 29] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -0.0285, -0.0361, -0.0548, -0.0905, -0.1057, -0.1355, -0.1683, -0.1982, -0.2291, -0.2523, -0.2719, -0.2833, -0.292, -0.3017, -0.321, -0.3621, -0.6364, -0.9061, -1.0604, -1.0853, -0.618];
#[rustfmt::skip]
const GAIN100_H_POS: [f64; 29] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0749, 0.0476, 0.0265, 0.0343, 0.0832, 0.0925, 0.1134, 0.1403, 0.1735, 0.2056, 0.2326, 0.2548, 0.2697, 0.2794, 0.2885, 0.2988, 0.3188, 0.3603, 0.554, 0.6777, 0.6751, 0.4355, 0.0];
#[rustfmt::skip]
const GAIN100_S_NEG: [f64; 29] = [-1.0247, -1.5247, -2.0247, -2.5247, -3.0247, -3.5247, -4.0, -3.7774, -3.4303, -3.2054, -2.5716, -2.4087, -2.1987, -2.1127, -2.1691, -2.1106, -2.0646, -1.9637, -1.8008, -1.5945, -1.197, -0.8621, -0.5819, -0.2478, -0.2117, -0.1516, -0.0945, -0.0418, 0.0];
#[rustfmt::skip]
const GAIN100_S_POS: [f64; 29] = [4.202, 3.7756, 3.3491, 2.9366, 2.5562, 2.1978, 2.1055, 2.2045, 2.3594, 2.7803, 3.2581, 3.2836, 3.2459, 3.1226, 2.9496, 2.6903, 2.4299, 2.1085, 1.7869, 1.5143, 1.1335, 0.8335, 0.5719, 0.2465, 0.1988, 0.1432, 0.0897, 0.0402, 0.0];
#[rustfmt::skip]
const GAIN50_H_NEG: [f64; 29] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -0.0285, -0.0239, -0.0283, -0.0401, -0.0523, -0.067, -0.0839, -0.0998, -0.1159, -0.1274, -0.1358, -0.1409, -0.1453, -0.1503, -0.16, -0.1807, -0.3145, -0.4234, -0.475, -0.4585, -0.2147];
#[rustfmt::skip]
const GAIN50_H_POS: [f64; 29] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0119, 0.0399, 0.0473, 0.0549, 0.0699, 0.0849, 0.1026, 0.1154, 0.1268, 0.135, 0.1405, 0.1449, 0.1498, 0.1598, 0.1807, 0.2902, 0.3676, 0.3831, 0.3343, 0.0];
#[rustfmt::skip]
const GAIN50_S_NEG: [f64; 29] = [-1.0247, -1.5247, -2.0247, -2.5247, -3.0131, -3.5, -3.0, -2.9301, -2.4531, -1.9154, -1.2042, -1.1572, -1.2147, -1.1986, -1.1703, -1.1533, -1.1329, -1.0504, -0.9306, -0.8011, -0.59, -0.4268, -0.2894, -0.1237, -0.1043, -0.0748, -0.0466, -0.0207, 0.0];
#[rustfmt::skip]
const GAIN50_S_POS: [f64; 29] = [2.9829, 2.6344, 2.2858, 1.9612, 1.6822, 1.4101, 1.3076, 1.1292, 0.9768, 1.1936, 1.4409, 1.4263, 1.4515, 1.457, 1.4308, 1.3421, 1.2334, 1.078, 0.9121, 0.7692, 0.5726, 0.4194, 0.2869, 0.1235, 0.101, 0.0727, 0.0454, 0.0203, 0.0];

fn interp_table(
    value: f64,
    neg50: &[f64; 29],
    neg100: &[f64; 29],
    pos50: &[f64; 29],
    pos100: &[f64; 29],
) -> [f64; 29] {
    if value == 0.0 {
        return [0.0; 29];
    }
    let (g50, g100) = if value > 0.0 {
        (pos50, pos100)
    } else {
        (neg50, neg100)
    };
    let v = value.abs();
    let mut out = [0.0; 29];
    if v <= 50.0 {
        let scale = v / 50.0;
        for i in 0..29 {
            out[i] = g50[i] * scale;
        }
    } else {
        let t = (v - 50.0) / 50.0;
        for i in 0..29 {
            out[i] = g50[i] + (g100[i] - g50[i]) * t;
        }
    }
    out
}

/// `SpatialGainScale`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GainScale {
    pub highlights_neg: f64,
    pub highlights_pos: f64,
    pub shadows_neg: f64,
    pub shadows_pos: f64,
}

impl GainScale {
    pub const IDENTITY: GainScale = GainScale {
        highlights_neg: 1.0,
        highlights_pos: 1.0,
        shadows_neg: 1.0,
        shadows_pos: 1.0,
    };
    /// `productionDefault` (no statistic available).
    pub const PRODUCTION_DEFAULT: GainScale = GainScale {
        highlights_neg: 0.5,
        highlights_pos: 0.5,
        shadows_neg: 0.8,
        shadows_pos: 0.8,
    };
}

/// `SpatialShift`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Shift {
    pub highlights: f64,
    pub shadows: f64,
}

pub fn highlights_gain_curve(value: f64, scale: GainScale) -> [f64; 29] {
    let mut curve = interp_table(
        value,
        &GAIN50_H_NEG,
        &GAIN100_H_NEG,
        &GAIN50_H_POS,
        &GAIN100_H_POS,
    );
    let k = if value > 0.0 {
        scale.highlights_pos
    } else {
        scale.highlights_neg
    };
    if k != 1.0 {
        for v in curve.iter_mut() {
            *v *= k;
        }
    }
    curve
}

pub fn shadows_gain_curve(value: f64, scale: GainScale) -> [f64; 29] {
    let mut curve = interp_table(
        value,
        &GAIN50_S_NEG,
        &GAIN100_S_NEG,
        &GAIN50_S_POS,
        &GAIN100_S_POS,
    );
    let k = if value > 0.0 {
        scale.shadows_pos
    } else {
        scale.shadows_neg
    };
    if k != 1.0 {
        for v in curve.iter_mut() {
            *v *= k;
        }
    }
    curve
}

/// `np.interp(x, _GRID, curve)`.
fn interp_curve(x: f64, curve: &[f64; 29]) -> f64 {
    if x <= grid(0) {
        return curve[0];
    }
    if x >= grid(28) {
        return curve[28];
    }
    for index in 1..=28 {
        if x <= grid(index) {
            let t = (x - grid(index - 1)) / (grid(index) - grid(index - 1));
            return curve[index - 1] + (curve[index] - curve[index - 1]) * t;
        }
    }
    curve[28]
}

// MARK: - Texture / Clarity (Model L)

const TEXTURE_GAIN60_NEG: [f64; 9] = [
    0.8567, 0.8955, 0.9436, 0.9797, 0.9951, 0.9996, 1.0005, 1.0008, 0.9982,
];
const TEXTURE_GAIN60_POS: [f64; 9] = [
    1.1616, 1.1282, 1.0704, 1.0265, 1.0074, 1.0015, 1.0007, 1.0004, 1.0031,
];
const CLARITY_GAIN60_NEG: [f64; 9] = [
    0.8517, 0.8534, 0.8603, 0.8787, 0.9153, 0.9696, 1.0039, 1.0177, 0.9972,
];
const CLARITY_GAIN60_POS: [f64; 9] = [
    1.3641, 1.3005, 1.2463, 1.203, 1.1634, 1.1203, 1.0776, 1.0456, 1.0155,
];
const CLARITY_LEVEL_OFFSET: usize = 3;
const SHADOWS_LEVELS_OFFSET: isize = -3;

/// `_gain_profile`.
pub fn gain_profile(amount: f64, pos: &[f64; 9], neg: &[f64; 9], levels_total: usize) -> Vec<f64> {
    let n = levels_total + 1;
    if amount == 0.0 {
        return vec![1.0; n];
    }
    let table = if amount > 0.0 { pos } else { neg };
    let scale = if amount > 0.0 {
        amount / 60.0
    } else {
        amount / -60.0
    };
    let dev: Vec<f64> = table.iter().map(|v| (v - 1.0) * scale).collect();
    if n <= dev.len() {
        return dev[..n].iter().map(|d| 1.0 + d).collect();
    }
    let mut result: Vec<f64> = dev.iter().map(|d| 1.0 + d).collect();
    let pad = 1.0 + dev[dev.len() - 1];
    result.resize(n, pad);
    result
}

/// `_apply_multiscale_gain` in place: Laplacian levels (each scaled by its
/// gain as it is formed) overwrite the Gaussian levels from fine to coarse,
/// then the pyramid is collapsed back into `ln`. Same values as the
/// reference's `laplacian_pyramid` / gains / `reconstruct` without the
/// full-size copies.
fn apply_multiscale_gain(mut ln: Plane, gains: &[f64]) -> Plane {
    let levels = gains.len() - 1;
    if levels == 0 {
        return ln;
    }
    let mut g = gaussian_levels(&ln, levels);
    // Level l's Laplacian needs level l + 1 still Gaussian: go fine to
    // coarse. `(G - up) * k` rounds exactly like storing `G - up` first.
    let k0 = gains[0] as f32;
    let w = ln.width;
    pyr_up_each_row(&g[0], &mut ln.data, w, |_, dst, row| {
        for (v, u) in dst.iter_mut().zip(row) {
            *v = (*v - u) * k0;
        }
    });
    for l in 1..levels {
        let (lo, hi) = g.split_at_mut(l);
        let lower = &mut lo[l - 1];
        let k = gains[l] as f32;
        let w = lower.width;
        pyr_up_each_row(&hi[0], &mut lower.data, w, |_, dst, row| {
            for (v, u) in dst.iter_mut().zip(row) {
                *v = (*v - u) * k;
            }
        });
    }
    let kb = gains[levels] as f32;
    for v in g[levels - 1].data.iter_mut() {
        *v *= kb;
    }
    for l in (1..levels).rev() {
        let (lo, hi) = g.split_at_mut(l);
        add_pyr_up(&hi[0], &mut lo[l - 1]);
    }
    add_pyr_up(&g[0], &mut ln);
    ln
}

// MARK: - Local Laplacian

#[inline]
fn remap_magnitude(ad: f32, sigma_r: f32, alpha: f32, beta: f32) -> f32 {
    if ad <= sigma_r {
        if alpha == 1.0 {
            return sigma_r * (ad / sigma_r).max(0.0);
        }
        return sigma_r * libm::powf((ad / sigma_r).max(0.0), alpha);
    }
    beta * (ad - sigma_r) + sigma_r
}

/// `np.searchsorted(grid, v, side="left") - 1`.
fn bracket_index(grid: &[f64], v: f64) -> isize {
    let mut lo = 0usize;
    let mut hi = grid.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if grid[mid] < v {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo as isize - 1
}

struct OpParams {
    alpha: f32,
    beta: f32,
    sigma_r: f32,
}

const HIGHLIGHTS_PARAMS: OpParams = OpParams {
    alpha: 1.0,
    beta: 1.0,
    sigma_r: 1.0,
};
const SHADOWS_PARAMS: OpParams = OpParams {
    alpha: 1.0,
    beta: 0.85,
    sigma_r: 0.5,
};

/// `_apply_single_op_llf`. Level 0 of the pyramids is the input itself;
/// the Laplacian coefficients are consumed as `pyr_up` produces them and
/// the result is collapsed in place into the finest accumulator, so the
/// only full-size planes are the output, the remapped image and the
/// level-0 grid indices (`u8`; the fraction is recomputed when needed).
fn apply_single_op_llf(
    ln: &Plane,
    curve: &dyn Fn(f64) -> f64,
    params: &OpParams,
    levels: usize,
    n_disc: usize,
) -> Plane {
    // g[l - 1] is Gaussian level l.
    let g = gaussian_levels(ln, levels);
    if params.alpha == 1.0 && params.beta == 1.0 {
        // Identity remap: result = G0 + up^L(curve(G_L)). Algebraically the
        // reference's laplacian/reconstruct with the base shifted by the
        // curve (pyrUp is linear), without rebuilding every level.
        let base = &g[levels - 1];
        let mut d = Plane::new(base.width, base.height);
        for (dst, v) in d.data.iter_mut().zip(base.data.iter()) {
            *dst = curve(*v as f64) as f32;
        }
        for level in (1..levels).rev() {
            d = pyr_up(&d, g[level - 1].width, g[level - 1].height);
        }
        let w = ln.width;
        let mut out = Plane::new(w, ln.height);
        pyr_up_each_row(&d, &mut out.data, w, |y, dst, row| {
            let src = &ln.data[y * w..(y + 1) * w];
            for ((o, s), dv) in dst.iter_mut().zip(src).zip(row) {
                *o = s + dv;
            }
        });
        return out;
    }

    let (mut gmin, mut gmax) = (f32::INFINITY, f32::NEG_INFINITY);
    for v in &ln.data {
        gmin = gmin.min(*v);
        gmax = gmax.max(*v);
    }
    let (gmin, gmax) = (gmin as f64, gmax as f64);
    let pad = 0.05 * (gmax - gmin + 1e-6);
    let lo = gmin - pad;
    let hi = gmax + pad;
    let n = n_disc.max(1);
    let g0_grid: Vec<f64> = if n <= 1 {
        vec![lo]
    } else {
        (0..n)
            .map(|i| lo + (hi - lo) * i as f64 / (n - 1) as f64)
            .collect()
    };
    let bracket = |v: f64| -> usize {
        bracket_index(&g0_grid, v).clamp(0, n.saturating_sub(2) as isize) as usize
    };
    let fraction = |i: usize, v: f64| -> f32 {
        let (g_lo, g_hi) = if n >= 2 {
            (g0_grid[i], g0_grid[i + 1])
        } else {
            (g0_grid[0], g0_grid[0])
        };
        ((v - g_lo) / (g_hi - g_lo + 1e-12)).clamp(0.0, 1.0) as f32
    };

    // Per level: bracketing grid index (and, above level 0, the fraction).
    let idx0: Vec<u8> = ln.data.iter().map(|v| bracket(*v as f64) as u8).collect();
    let mut idx_by_level: Vec<Vec<u8>> = Vec::with_capacity(levels.saturating_sub(1));
    let mut frac_by_level: Vec<Vec<f32>> = Vec::with_capacity(levels.saturating_sub(1));
    for plane in g.iter().take(levels - 1) {
        let mut idx = Vec::with_capacity(plane.data.len());
        let mut frac = Vec::with_capacity(plane.data.len());
        for v in &plane.data {
            let v = *v as f64;
            let i = bracket(v);
            idx.push(i as u8);
            frac.push(fraction(i, v));
        }
        idx_by_level.push(idx);
        frac_by_level.push(frac);
    }

    let mut acc: Vec<Plane> = Vec::with_capacity(levels + 1);
    acc.push(Plane::new(ln.width, ln.height));
    for plane in g.iter().take(levels - 1) {
        acc.push(Plane::new(plane.width, plane.height));
    }
    let mut remapped = Plane::new(ln.width, ln.height);
    for (k, g0) in g0_grid.iter().enumerate() {
        let g0 = *g0 as f32;
        let w = ln.width;
        crate::par::for_each_row_mut(&mut remapped.data, w, |y, row| {
            for (dst, v) in row.iter_mut().zip(ln.data[y * w..].iter()) {
                let d = v - g0;
                let ad = d.abs();
                let sgn = if d > 0.0 {
                    1.0
                } else if d < 0.0 {
                    -1.0
                } else {
                    0.0
                };
                *dst = g0 + sgn * remap_magnitude(ad, params.sigma_r, params.alpha, params.beta);
            }
        });
        let gk = gaussian_levels(&remapped, levels);
        // Level 0: the fraction comes from the input value.
        {
            let remapped = &remapped;
            pyr_up_each_row(&gk[0], &mut acc[0].data, w, |y, a, row| {
                let start = y * w;
                for (x, u) in row.iter().enumerate() {
                    let i = start + x;
                    let ii = idx0[i] as usize;
                    let wt = if ii == k {
                        1.0 - fraction(ii, ln.data[i] as f64)
                    } else if ii + 1 == k {
                        fraction(ii, ln.data[i] as f64)
                    } else {
                        continue;
                    };
                    if wt != 0.0 {
                        a[x] += wt * (remapped.data[i] - u);
                    }
                }
            });
        }
        for l in 1..levels {
            let lower = &gk[l - 1];
            let idx = &idx_by_level[l - 1];
            let frac = &frac_by_level[l - 1];
            let w = lower.width;
            pyr_up_each_row(&gk[l], &mut acc[l].data, w, |y, a, row| {
                let start = y * w;
                for (x, u) in row.iter().enumerate() {
                    let i = start + x;
                    let ii = idx[i] as usize;
                    let wt = if ii == k {
                        1.0 - frac[i]
                    } else if ii + 1 == k {
                        frac[i]
                    } else {
                        continue;
                    };
                    if wt != 0.0 {
                        a[x] += wt * (lower.data[i] - u);
                    }
                }
            });
        }
    }
    drop(remapped);
    let mut base = g[levels - 1].clone();
    for v in base.data.iter_mut() {
        *v += curve(*v as f64) as f32;
    }
    drop(g);
    acc.push(base);
    for l in (0..levels).rev() {
        let (lo, hi) = acc.split_at_mut(l + 1);
        add_pyr_up(&hi[0], &mut lo[l]);
    }
    acc.swap_remove(0)
}

/// Every spatial control and the resolved adaptive parameters.
#[derive(Debug, Clone, Copy)]
pub struct SpatialParams {
    pub highlights: f64,
    pub shadows: f64,
    pub texture: f64,
    pub clarity: f64,
    /// `scale_px(long_edge)` (the pyramid depth; tests set it directly).
    pub scale_px: f64,
    /// The long edge the radii follow: the image's, or with a geometry the
    /// whole frame's at this scale (not the cropped window's). The drag
    /// frame's half resolution takes half of it.
    pub long_edge: usize,
    pub gain_scale: GainScale,
    pub shift: Shift,
    pub quality: Quality,
}

impl SpatialParams {
    pub fn is_active(&self) -> bool {
        self.highlights != 0.0 || self.shadows != 0.0 || self.texture != 0.0 || self.clarity != 0.0
    }
}

/// `log2(max(Y, 3e-5))` of one linear ProPhoto pixel (the value
/// [`luminance_plane`] stores).
#[inline]
pub fn log_luminance(px: [f32; 3]) -> f32 {
    let y = px[0] * PP_LUMA_F32[0] + px[1] * PP_LUMA_F32[1] + px[2] * PP_LUMA_F32[2];
    libm::log2f(y.max(EPS))
}

/// `SpatialToneOps.luminancePlane`: `log2(max(Y, 3e-5))` of ProPhoto RGB.
pub fn luminance_plane(rgb: &[f32], width: usize, height: usize) -> Plane {
    let mut p = Plane::new(width, height);
    crate::par::for_each_row_mut(&mut p.data, width, |y, row| {
        for (dst, px) in row.iter_mut().zip(rgb[y * width * 3..].chunks_exact(3)) {
            *dst = log_luminance([px[0], px[1], px[2]]);
        }
    });
    p
}

/// Highlights -> Shadows -> Texture -> Clarity on the log luminance `ln0`
/// (`applyHighlightsShadows` before its final ratio). Returns the final Ln,
/// or `None` when no control is active; the caller multiplies each pixel by
/// `exp2(Ln_final - Ln0)`. `ln0` is only read, and each stage frees its
/// input as soon as the next one exists.
pub fn spatial_luminance(ln0: &Plane, p: &SpatialParams) -> Option<Plane> {
    if !p.is_active() || ln0.width == 0 || ln0.height == 0 {
        return None;
    }
    run_stages(ln0, None, p, true)
}

/// Shortest side below which [`preview_luminance`] runs the reference.
const PREVIEW_MIN_SIDE: usize = 64;

/// The local pass of an interactive (drag) frame: Highlights and Shadows
/// run on the half-resolution log luminance (Gaussian level 1 of `ln0`,
/// with the radii of half of `p.long_edge`) and their change is brought
/// back with `pyr_up`; Texture and Clarity then run at full resolution as
/// in [`spatial_luminance`] (their finest band is what the slider shows).
/// The released frame uses [`spatial_luminance`], the reference.
pub fn preview_luminance(ln0: &Plane, p: &SpatialParams) -> Option<Plane> {
    if !p.is_active() || ln0.width == 0 || ln0.height == 0 {
        return None;
    }
    let half_long_edge = p.long_edge.div_ceil(2);
    let half_scale_px = scale_px(half_long_edge as f64);
    // At half size the Shadows pyramid must keep its depth (it is clamped to
    // one level below ~1060px), or the preview would use a larger radius.
    let shadows_depth_kept =
        p.shadows == 0.0 || levels_for_scale(half_scale_px) as isize + SHADOWS_LEVELS_OFFSET >= 1;
    if (p.highlights == 0.0 && p.shadows == 0.0)
        || ln0.width.min(ln0.height) < PREVIEW_MIN_SIDE
        || !shadows_depth_kept
    {
        return spatial_luminance(ln0, p);
    }
    let half = pyr_down(ln0);
    let half_params = SpatialParams {
        texture: 0.0,
        clarity: 0.0,
        scale_px: half_scale_px,
        long_edge: half_long_edge,
        ..*p
    };
    let mut delta = run_stages(&half, None, &half_params, false)?;
    for (d, h) in delta.data.iter_mut().zip(half.data.iter()) {
        *d -= h;
    }
    drop(half);
    let w = ln0.width;
    let mut ln = Plane::new(w, ln0.height);
    pyr_up_each_row(&delta, &mut ln.data, w, |y, dst, row| {
        let src = &ln0.data[y * w..(y + 1) * w];
        for ((o, s), dv) in dst.iter_mut().zip(src).zip(row) {
            *o = s + dv;
        }
    });
    drop(delta);
    let texture_clarity = SpatialParams {
        highlights: 0.0,
        shadows: 0.0,
        ..*p
    };
    if texture_clarity.is_active() {
        run_stages(ln0, Some(ln), &texture_clarity, true)
    } else {
        Some(ln)
    }
}

/// The stages of `p` in order, starting from `start` (or `ln0`). With
/// `texture_clarity: false` only Highlights / Shadows run.
fn run_stages(
    ln0: &Plane,
    start: Option<Plane>,
    p: &SpatialParams,
    texture_clarity: bool,
) -> Option<Plane> {
    let levels_h = levels_for_scale(p.scale_px);
    let mut ln: Option<Plane> = start;
    if p.highlights != 0.0 {
        let table = highlights_gain_curve(p.highlights, p.gain_scale);
        let shift = p.shift.highlights;
        let next = apply_single_op_llf(
            ln.as_ref().unwrap_or(ln0),
            &|x| interp_curve(x - shift, &table),
            &HIGHLIGHTS_PARAMS,
            levels_h,
            1,
        );
        ln = Some(next);
    }
    if p.shadows != 0.0 {
        let levels_s = (levels_h as isize + SHADOWS_LEVELS_OFFSET).max(1) as usize;
        let table = shadows_gain_curve(p.shadows, p.gain_scale);
        let shift = p.shift.shadows;
        let next = apply_single_op_llf(
            ln.as_ref().unwrap_or(ln0),
            &|x| interp_curve(x - shift, &table),
            &SHADOWS_PARAMS,
            levels_s,
            p.quality.shadows_discretization(),
        );
        ln = Some(next);
    }
    if !texture_clarity {
        return ln;
    }
    if p.texture != 0.0 {
        let gains = gain_profile(
            p.texture,
            &TEXTURE_GAIN60_POS,
            &TEXTURE_GAIN60_NEG,
            levels_h,
        );
        let input = ln.take().unwrap_or_else(|| ln0.clone());
        ln = Some(apply_multiscale_gain(input, &gains));
    }
    if p.clarity != 0.0 {
        let gains = gain_profile(
            p.clarity,
            &CLARITY_GAIN60_POS,
            &CLARITY_GAIN60_NEG,
            levels_h + CLARITY_LEVEL_OFFSET,
        );
        let input = ln.take().unwrap_or_else(|| ln0.clone());
        ln = Some(apply_multiscale_gain(input, &gains));
    }
    ln
}

/// `applyHighlightsShadows` (Highlights -> Shadows -> Texture -> Clarity on
/// Ln, one ratio at the end). `rgb` is linear ProPhoto, interleaved RGB,
/// modified in place. Not clipped (the next cube clips).
pub fn apply_in_place(rgb: &mut [f32], width: usize, height: usize, p: &SpatialParams) {
    if !p.is_active() || width == 0 || height == 0 {
        return;
    }
    let ln0 = luminance_plane(rgb, width, height);
    let Some(ln) = spatial_luminance(&ln0, p) else {
        return;
    };
    crate::par::for_each_row_mut(rgb, width * 3, |y, row| {
        for ((px, l1), l0) in row
            .chunks_exact_mut(3)
            .zip(ln.data[y * width..].iter())
            .zip(ln0.data[y * width..].iter())
        {
            let ratio = libm::exp2f(l1 - l0);
            px[0] *= ratio;
            px[1] *= ratio;
            px[2] *= ratio;
        }
    });
}

// MARK: - Adaptive statistics and laws (`SpatialAdaptiveStats` / `Law`)

/// `SpatialAdaptiveStats.Stats`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdaptiveStats {
    pub highlight_ratio_base: f64,
    pub mean_ln: f64,
    pub full_highlight_ratio: f64,
    pub full_p90: f64,
}

const LN_FLOOR: f32 = 1e-4;
const HIGHLIGHT_THRESHOLD: f32 = -1.0;

/// Stats of straight RGB (already at the statistic resolution).
pub fn compute_stats(rgb: &[f32], width: usize, height: usize, luma: [f32; 3]) -> AdaptiveStats {
    let mut ln = Plane::new(width, height);
    crate::par::for_each_row_mut(&mut ln.data, width, |row_index, row| {
        for (dst, px) in row
            .iter_mut()
            .zip(rgb[row_index * width * 3..].chunks_exact(3))
        {
            let y = (px[0] * luma[0] + px[1] * luma[1] + px[2] * luma[2]).max(LN_FLOOR);
            *dst = libm::log2f(y);
        }
    });
    // The sum stays in pixel order (a reduction is not split).
    let mut sum = 0.0f64;
    for value in &ln.data {
        sum += *value as f64;
    }
    let count = ln.data.len().max(1) as f64;
    let mean_ln = if ln.data.is_empty() { 0.0 } else { sum / count };
    let full_highlight_ratio = highlight_ratio(&ln);
    let full_p90 = percentile(&ln.data, 90.0);
    let sigma = width.max(height) as f64 * (32.0 / 1500.0);
    let blurred = gaussian_blur(&ln, sigma);
    AdaptiveStats {
        highlight_ratio_base: highlight_ratio(&blurred),
        mean_ln,
        full_highlight_ratio,
        full_p90,
    }
}

fn highlight_ratio(p: &Plane) -> f64 {
    if p.data.is_empty() {
        return 0.0;
    }
    let count = p.data.iter().filter(|v| **v > HIGHLIGHT_THRESHOLD).count();
    count as f64 / p.data.len() as f64
}

/// numpy `percentile` (linear).
fn percentile(values: &[f32], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    if sorted.len() == 1 {
        return sorted[0] as f64;
    }
    let rank = (p / 100.0) * (sorted.len() - 1) as f64;
    let low = libm::floor(rank) as usize;
    let high = libm::ceil(rank) as usize;
    let (_, lo_v, upper) = sorted.select_nth_unstable_by(low, |a, b| a.total_cmp(b));
    let lo_v = *lo_v as f64;
    if low == high {
        return lo_v;
    }
    let hi_v = upper.iter().copied().fold(f32::INFINITY, f32::min) as f64;
    lo_v + (hi_v - lo_v) * (rank - low as f64)
}

/// `SpatialAdaptiveStats.gaussianBlur` (±3σ, reflect borders).
fn gaussian_blur(p: &Plane, sigma: f64) -> Plane {
    if sigma <= 0.0 || p.width == 0 || p.height == 0 {
        return p.clone();
    }
    let radius = (libm::ceil(sigma * 3.0) as isize).max(1);
    let mut kernel: Vec<f32> = (-radius..=radius)
        .map(|o| libm::exp(-((o * o) as f64) / (2.0 * sigma * sigma)) as f32)
        .collect();
    let s: f32 = kernel.iter().sum();
    for k in kernel.iter_mut() {
        *k /= s;
    }
    let mut horizontal = Plane::new(p.width, p.height);
    let xmap: Vec<Vec<usize>> = (0..p.width)
        .map(|x| {
            (-radius..=radius)
                .map(|o| reflect_index(x as isize + o, p.width))
                .collect()
        })
        .collect();
    // The rows of each pass read only the pass before, so they may run on
    // different threads (#150).
    crate::par::for_each_row_mut(&mut horizontal.data, p.width, |y, dst| {
        let row = &p.data[y * p.width..(y + 1) * p.width];
        for (d, taps) in dst.iter_mut().zip(xmap.iter()) {
            let mut acc = 0.0f32;
            for (idx, w) in taps.iter().zip(kernel.iter()) {
                acc += row[*idx] * w;
            }
            *d = acc;
        }
    });
    let mut out = Plane::new(p.width, p.height);
    crate::par::for_each_row_mut(&mut out.data, p.width, |y, dst| {
        for (o, w) in (-radius..=radius).zip(kernel.iter()) {
            let sy = reflect_index(y as isize + o, p.height);
            let src = &horizontal.data[sy * p.width..(sy + 1) * p.width];
            for x in 0..p.width {
                dst[x] += src[x] * w;
            }
        }
    });
    out
}

/// Which law family resolves the parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdaptivePath {
    Raw,
    NonRaw,
}

/// Production resolution of `SpatialGainScale.current(stats:path:)` and
/// `SpatialShift.current(stats:path:)` with no environment overrides (RAW:
/// `SpatialAdaptiveVersion.shiftRefit`).
pub fn adaptive_parameters(
    stats: Option<&AdaptiveStats>,
    path: AdaptivePath,
) -> (GainScale, Shift) {
    let Some(s) = stats else {
        return (GainScale::PRODUCTION_DEFAULT, Shift::default());
    };
    match path {
        AdaptivePath::Raw => {
            let ks = (0.6190 + 0.9441 * s.highlight_ratio_base).clamp(0.6, 1.5);
            let shift = (1.5609 + 0.5757 * s.mean_ln).clamp(-3.0, 0.0);
            (
                GainScale {
                    highlights_neg: 0.5,
                    highlights_pos: 0.5,
                    shadows_neg: ks,
                    shadows_pos: ks,
                },
                Shift {
                    highlights: 0.0,
                    shadows: shift,
                },
            )
        }
        AdaptivePath::NonRaw => {
            let kh = (1.0217 - 1.9300 * s.highlight_ratio_base).clamp(0.3, 1.1);
            let ks = (0.6198 + 1.9151 * s.full_highlight_ratio).clamp(0.6, 2.2);
            let shift = (0.2363 + 0.6521 * s.full_p90).clamp(-2.0, 0.0);
            (
                GainScale {
                    highlights_neg: kh,
                    highlights_pos: kh,
                    shadows_neg: ks,
                    shadows_pos: ks,
                },
                Shift {
                    highlights: 0.0,
                    shadows: shift,
                },
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reflect_matches_numpy() {
        let n = 5;
        let got: Vec<usize> = (-4..9).map(|i| reflect_index(i, n)).collect();
        assert_eq!(got, vec![4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 0]);
    }

    #[test]
    fn levels_round_half_even() {
        assert_eq!(levels_for_scale(scale_px(1500.0)), 5);
        assert_eq!(levels_for_scale(scale_px(2560.0)), 6);
        assert_eq!(levels_for_scale(scale_px(1280.0)), 5);
        assert_eq!(levels_for_scale(1.0), 1);
    }

    #[test]
    fn reconstruct_inverts_laplacian() {
        let mut p = Plane::new(37, 23);
        for (i, v) in p.data.iter_mut().enumerate() {
            *v = ((i * 7919) % 101) as f32 / 101.0 - 3.0;
        }
        let g = gaussian_pyramid(&p, 4);
        let lap = laplacian_pyramid(&g);
        let back = reconstruct(&lap);
        for (a, b) in back.data.iter().zip(p.data.iter()) {
            assert!((a - b).abs() < 1e-5);
        }
    }
}
