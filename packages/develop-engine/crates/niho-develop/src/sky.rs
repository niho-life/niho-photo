//! Sky masks made from the photo itself (niho-photo#141,
//! `docs/local-adjustments.md` "空の検出"): candidate "A" of #128, frozen as
//! v1. A NIHO-owned estimate without learned weights, made only of box
//! filters, a least-squares fit of a few coefficients, breadth-first flood
//! fills and a guided filter.
//!
//! 1. **Analysis image.** The photo resampled to a long side of
//!    [`ANALYSIS_LONG_SIDE`] (PIL's bilinear: a triangle filter whose support
//!    grows with the reduction), in CIE Lab (D65): luminance `L / 100`, the
//!    local texture (the mean over 5 x 5 of the luminance gradient, numpy's
//!    `gradient`) and the position.
//! 2. **Seed.** Smooth, bright, sky-coloured pixels (blue, bright neutral,
//!    or warm and bright) in the upper three quarters, kept where they
//!    connect to the top edge. With the capture's exposure (`ev100`)
//!    "bright" is the pixel's scene brightness (EV 12 and up at ISO 100, or
//!    clipped); without it, brighter than 0.6 and the photo's 75th
//!    percentile. A seed under 1% of the frame (windows, no sky at the top)
//!    falls back to smooth, bright, blue or clipped neutral pixels anywhere in
//!    the upper half; under 0.5% there is no sky.
//! 3. **Sky colour field.** `L, a, b ~ (1, x, y, x*y, y^2)` fitted on the
//!    seed, evaluated with `y` held within the seed's rows (no extrapolation);
//!    a pixel's distance to it weighs `L` by half.
//! 4. **Region growing** from the seed through bright pixels that are smooth
//!    and near the field, or cloud (bright, colourless, among the brightest,
//!    soft texture), plus isolated bright pixels very near the field down to
//!    just below the region (sky through branches and window frames).
//! 5. **Output size.** The region resampled to the photo's size; near its
//!    edge the field distance decides half, then a guided filter on the
//!    photo's luminance (radius `long side / 256`, at least 2; eps 1e-3)
//!    snaps the edge.
//!
//! A port of the prototype of #128 (`sky_a.py` and its Rust twin, compared
//! on 30 photos): the same steps, constants, rounding (half to even), PIL's
//! resample, numpy's percentile and gradient. Do not tune it here: a later
//! step changes it against measured scenes. The transcendental functions
//! are `libm`'s (the ones a wasm build links), so native and wasm agree bit
//! for bit and the same input gives the same bytes. Single threaded.

use std::collections::VecDeque;
use std::fmt;

/// Long side of the analysis image the seed, the field and the region are
/// found on.
pub const ANALYSIS_LONG_SIDE: usize = 384;

/// An estimated sky: `width * height` values, row-major, 0 (not sky) ..=
/// 255 (sky), at the input's size (the bytes of a mask surface,
/// [`crate::mask_surface::MaskSurface::new`]).
#[derive(Clone, PartialEq, Eq)]
pub struct SkySurface {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl fmt::Debug for SkySurface {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SkySurface({}x{})", self.width, self.height)
    }
}

/// The sky of a photo. `rgb` is sRGB 8-bit RGB (3 bytes per pixel,
/// row-major) of `width x height`; `ev100` is the capture's exposure value
/// at ISO 100 (`log2(N^2 / t) - log2(ISO / 100)`), `None` when unknown
/// (brightness is then relative to the photo). Returns the surface at the
/// input's size, or `None` when the estimate finds no sky.
///
/// Input it cannot read is `None` too: a zero side, `rgb` not `width *
/// height * 3` bytes, a side past `u32`. A non-finite `ev100` counts as
/// unknown.
pub fn estimate_sky(
    rgb: &[u8],
    width: usize,
    height: usize,
    ev100: Option<f64>,
) -> Option<SkySurface> {
    if width == 0 || height == 0 {
        return None;
    }
    if width.checked_mul(height)?.checked_mul(3)? != rgb.len() {
        return None;
    }
    let (out_width, out_height) = (u32::try_from(width).ok()?, u32::try_from(height).ok()?);
    let probability = sky_probability(rgb, width, height, ev100.filter(|ev| ev.is_finite()))?;
    let data = probability
        .iter()
        .map(|&p| (p * 255.0).round_ties_even() as u8)
        .collect();
    Some(SkySurface {
        width: out_width,
        height: out_height,
        data,
    })
}

struct Plane {
    w: usize,
    h: usize,
    v: Vec<f32>,
}

impl Plane {
    fn new(w: usize, h: usize) -> Self {
        Plane {
            w,
            h,
            v: vec![0.0; w * h],
        }
    }
}

/// PIL's `BILINEAR` resample along one axis (a triangle filter whose support
/// grows with the reduction), accumulated in `f64`. `src` holds `lines`
/// lines of `len_in` samples of `channels` interleaved values: along the
/// rows (`rows`) line `o` is row `o`, otherwise it is column `o` of an image
/// `lines` columns wide. The output keeps that layout with `len_out` samples
/// per line.
fn resample_axis(
    src: &[f32],
    len_in: usize,
    len_out: usize,
    channels: usize,
    lines: usize,
    rows: bool,
) -> Vec<f32> {
    let scale = len_in as f64 / len_out as f64;
    let filterscale = scale.max(1.0);
    let support = filterscale;
    let ss = 1.0 / filterscale;
    let taps: Vec<(usize, Vec<f64>)> = (0..len_out)
        .map(|xx| {
            let center = (xx as f64 + 0.5) * scale;
            let xmin = ((center - support + 0.5) as i64).max(0) as usize;
            let xmax = ((center + support + 0.5) as i64).min(len_in as i64) as usize - xmin;
            let mut weights: Vec<f64> = (0..xmax)
                .map(|x| {
                    let t = ((x + xmin) as f64 - center + 0.5) * ss;
                    if t.abs() < 1.0 {
                        1.0 - t.abs()
                    } else {
                        0.0
                    }
                })
                .collect();
            let total: f64 = weights.iter().sum();
            if total != 0.0 {
                weights.iter_mut().for_each(|w| *w /= total);
            }
            (xmin, weights)
        })
        .collect();
    let mut out = vec![0.0f32; lines * len_out * channels];
    for o in 0..lines {
        for c in 0..channels {
            for (xx, (xmin, weights)) in taps.iter().enumerate() {
                let mut acc = 0.0f64;
                for (k, w) in weights.iter().enumerate() {
                    let i = if rows {
                        (o * len_in + xmin + k) * channels + c
                    } else {
                        ((xmin + k) * lines + o) * channels + c
                    };
                    acc += src[i] as f64 * w;
                }
                let j = if rows {
                    (o * len_out + xx) * channels + c
                } else {
                    (xx * lines + o) * channels + c
                };
                out[j] = acc as f32;
            }
        }
    }
    out
}

/// Resizes an interleaved image of `channels` values per pixel (the
/// horizontal pass, then the vertical one, like PIL).
fn resize(src: &[f32], w: usize, h: usize, channels: usize, ow: usize, oh: usize) -> Vec<f32> {
    let horizontal = if ow != w {
        resample_axis(src, w, ow, channels, h, true)
    } else {
        src.to_vec()
    };
    if oh != h {
        resample_axis(&horizontal, h, oh, channels, ow, false)
    } else {
        horizontal
    }
}

fn srgb_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        libm::powf((v + 0.055) / 1.055, 2.4)
    }
}

fn lab_f(t: f32) -> f32 {
    if t > 0.008856 {
        libm::cbrtf(t)
    } else {
        7.787 * t + 16.0 / 116.0
    }
}

/// sRGB (0..1, interleaved RGB) -> CIE Lab (D65).
fn srgb_to_lab(rgb: &[f32]) -> Vec<[f32; 3]> {
    rgb.chunks_exact(3)
        .map(|c| {
            let (r, g, b) = (srgb_linear(c[0]), srgb_linear(c[1]), srgb_linear(c[2]));
            let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
            let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
            let (fx, fy, fz) = (lab_f(x), lab_f(y), lab_f(z));
            [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
        })
        .collect()
}

/// Mean over a `(2r+1)^2` window, indices clamped to the edge (separable
/// running sums in `f64`).
fn box_mean(p: &Plane, r: usize) -> Plane {
    let (w, h) = (p.w, p.h);
    let k = (2 * r + 1) as f64;
    let ri = r as isize;
    let clamp = |i: isize, n: usize| i.clamp(0, n as isize - 1) as usize;
    let mut tmp = vec![0.0f64; w * h];
    for y in 0..h {
        let row = &p.v[y * w..(y + 1) * w];
        let mut s: f64 = (-ri..=ri).map(|t| row[clamp(t, w)] as f64).sum();
        for x in 0..w {
            tmp[y * w + x] = s;
            s += row[clamp(x as isize + ri + 1, w)] as f64 - row[clamp(x as isize - ri, w)] as f64;
        }
    }
    let mut out = Plane::new(w, h);
    for x in 0..w {
        let mut s: f64 = (-ri..=ri).map(|t| tmp[clamp(t, h) * w + x]).sum();
        for y in 0..h {
            out.v[y * w + x] = (s / (k * k)) as f32;
            s +=
                tmp[clamp(y as isize + ri + 1, h) * w + x] - tmp[clamp(y as isize - ri, h) * w + x];
        }
    }
    out
}

/// He et al.'s guided filter with a grey guide.
fn guided_filter(guide: &Plane, src: &Plane, r: usize, eps: f32) -> Plane {
    let mul = |a: &Plane, b: &Plane| Plane {
        w: a.w,
        h: a.h,
        v: a.v.iter().zip(&b.v).map(|(x, y)| x * y).collect(),
    };
    let mean_i = box_mean(guide, r);
    let mean_p = box_mean(src, r);
    let corr_ip = box_mean(&mul(guide, src), r);
    let corr_ii = box_mean(&mul(guide, guide), r);
    let n = guide.v.len();
    let mut a = Plane::new(guide.w, guide.h);
    let mut b = Plane::new(guide.w, guide.h);
    for i in 0..n {
        let cov = corr_ip.v[i] - mean_i.v[i] * mean_p.v[i];
        let var = corr_ii.v[i] - mean_i.v[i] * mean_i.v[i];
        a.v[i] = cov / (var + eps);
        b.v[i] = mean_p.v[i] - a.v[i] * mean_i.v[i];
    }
    let (ma, mb) = (box_mean(&a, r), box_mean(&b, r));
    Plane {
        w: guide.w,
        h: guide.h,
        v: (0..n).map(|i| ma.v[i] * guide.v[i] + mb.v[i]).collect(),
    }
}

/// numpy's default (linear) percentile of a non-empty slice.
fn percentile(v: &[f32], q: f64) -> f64 {
    let mut s: Vec<f32> = v.to_vec();
    let pos = q / 100.0 * (s.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = (lo + 1).min(s.len() - 1);
    let (_, &mut a, rest) = s.select_nth_unstable_by(lo, |x, y| x.total_cmp(y));
    let b = if hi == lo {
        a
    } else {
        rest.iter().copied().fold(f32::INFINITY, f32::min)
    };
    a as f64 + (b as f64 - a as f64) * (pos - lo as f64)
}

/// The pixels of `allowed` reachable from `seed & allowed` (4-neighbour,
/// breadth first).
fn flood(seed: &[bool], allowed: &[bool], w: usize, h: usize) -> Vec<bool> {
    let mut seen: Vec<bool> = seed.iter().zip(allowed).map(|(s, a)| *s && *a).collect();
    let mut queue: VecDeque<usize> = (0..w * h).filter(|&i| seen[i]).collect();
    while let Some(i) = queue.pop_front() {
        let (y, x) = (i / w, i % w);
        let mut visit = |j: usize| {
            if allowed[j] && !seen[j] {
                seen[j] = true;
                queue.push_back(j);
            }
        };
        if y > 0 {
            visit(i - w);
        }
        if y + 1 < h {
            visit(i + w);
        }
        if x > 0 {
            visit(i - 1);
        }
        if x + 1 < w {
            visit(i + 1);
        }
    }
    seen
}

fn design(x: f64, y: f64) -> [f64; 5] {
    [1.0, x, y, x * y, y * y]
}

/// Least squares of 5 coefficients per channel (normal equations, Gaussian
/// elimination with partial pivoting; a vanishing pivot leaves its
/// coefficient 0).
#[allow(clippy::needless_range_loop)]
fn fit(rows: &[([f64; 5], [f32; 3])]) -> [[f64; 3]; 5] {
    let mut m = [[0.0f64; 8]; 5];
    for (d, t) in rows {
        for i in 0..5 {
            for j in 0..5 {
                m[i][j] += d[i] * d[j];
            }
            for c in 0..3 {
                m[i][5 + c] += d[i] * t[c] as f64;
            }
        }
    }
    for col in 0..5 {
        let pivot = (col..5)
            .max_by(|&a, &b| m[a][col].abs().total_cmp(&m[b][col].abs()))
            .unwrap_or(col);
        m.swap(col, pivot);
        let p = m[col][col];
        if p.abs() < 1e-12 {
            continue;
        }
        for row in 0..5 {
            if row != col {
                let f = m[row][col] / p;
                for k in col..8 {
                    m[row][k] -= f * m[col][k];
                }
            }
        }
    }
    let mut coef = [[0.0f64; 3]; 5];
    for i in 0..5 {
        for c in 0..3 {
            coef[i][c] = if m[i][i].abs() < 1e-12 {
                0.0
            } else {
                m[i][5 + c] / m[i][i]
            };
        }
    }
    coef
}

/// The sky colour the field gives at `(x, y)` (normalized position).
fn field(coef: &[[f64; 3]; 5], x: f64, y: f64) -> [f64; 3] {
    let d = design(x, y);
    std::array::from_fn(|c| (0..5).map(|i| d[i] * coef[i][c]).sum())
}

/// Distance of a Lab colour to the field's (`L` weighed by half).
fn distance(lab: &[f32; 3], pred: &[f64; 3]) -> f32 {
    let d = |k: usize| lab[k] as f64 - pred[k];
    (0.5 * d(0) * d(0) + d(1) * d(1) + d(2) * d(2)).sqrt() as f32
}

fn count(mask: &[bool]) -> usize {
    mask.iter().filter(|&&m| m).count()
}

/// Sky probability (0..1) at the input's size, `None` without sky. `rgb8`
/// holds `w0 * h0 * 3` bytes (checked by [`estimate_sky`]).
fn sky_probability(rgb8: &[u8], w0: usize, h0: usize, ev100: Option<f64>) -> Option<Vec<f32>> {
    let scale = ANALYSIS_LONG_SIDE as f64 / w0.max(h0) as f64;
    let aw = ((w0 as f64 * scale).round_ties_even() as usize).max(1);
    let ah = ((h0 as f64 * scale).round_ties_even() as usize).max(1);
    let full: Vec<f32> = rgb8.iter().map(|&v| v as f32 / 255.0).collect();
    let small = resize(&full, w0, h0, 3, aw, ah);
    let lab = srgb_to_lab(&small);
    let n = aw * ah;
    let lum: Vec<f32> = lab.iter().map(|l| l[0] / 100.0).collect();
    let lin_y: Vec<f32> = lum
        .iter()
        .map(|&l| {
            if l > 0.08 {
                let t = (l + 0.16) / 1.16;
                t * t * t
            } else {
                l / 9.033
            }
        })
        .collect();

    // Texture: the mean gradient magnitude over a small window (numpy's
    // `gradient`: central inside, one-sided at the edges).
    let mut grad = Plane::new(aw, ah);
    for y in 0..ah {
        for x in 0..aw {
            let at = |yy: usize, xx: usize| lum[yy * aw + xx];
            let gy = if ah < 2 {
                0.0
            } else if y == 0 {
                at(1, x) - at(0, x)
            } else if y == ah - 1 {
                at(y, x) - at(y - 1, x)
            } else {
                (at(y + 1, x) - at(y - 1, x)) / 2.0
            };
            let gx = if aw < 2 {
                0.0
            } else if x == 0 {
                at(y, 1) - at(y, 0)
            } else if x == aw - 1 {
                at(y, x) - at(y, x - 1)
            } else {
                (at(y, x + 1) - at(y, x - 1)) / 2.0
            };
            grad.v[y * aw + x] = (gx * gx + gy * gy).sqrt();
        }
    }
    let texture = box_mean(&grad, 2).v;
    let tex_ref = percentile(&texture, 60.0) + 1e-4;
    let p70 = percentile(&lum, 70.0);
    let p75 = percentile(&lum, 75.0);
    let p80 = percentile(&lum, 80.0);
    let yn = |i: usize| (i / aw) as f64 / (ah.max(2) - 1) as f64;
    let xn = |i: usize| (i % aw) as f64 / (aw.max(2) - 1) as f64;

    let mut smooth = vec![false; n];
    let mut bright = vec![false; n];
    let mut blue = vec![false; n];
    let mut neutral_clipped = vec![false; n];
    let mut candidate = vec![false; n];
    let mut cloud = vec![false; n];
    for i in 0..n {
        let [_, a, b] = lab[i];
        let c = libm::hypotf(a, b);
        let hue = libm::atan2(b as f64, a as f64)
            .to_degrees()
            .rem_euclid(360.0);
        let t = texture[i] as f64;
        smooth[i] = t < 0.35 * tex_ref + 0.004;
        // Clouds: textured, but without hard edges.
        let soft = t < 2.0 * tex_ref + 0.01;
        blue[i] = hue > 190.0 && hue < 300.0 && c > 8.0;
        let neutral = c < 12.0;
        let l = lum[i] as f64;
        // Dusk: orange / pink.
        let warm = !(90.0..=300.0).contains(&hue) && c > 12.0 && l > 0.45;
        let clipped = lin_y[i] > 0.9;
        bright[i] = match ev100 {
            // The pixel's scene brightness (EV at ISO 100; mid grey is the
            // capture's EV). Daylight sky is EV 12-16; lit walls indoors stay
            // near 8-11.
            Some(ev) => ev + libm::log2((lin_y[i].max(1e-4) / 0.18) as f64) >= 12.0 || clipped,
            None => l > 0.6f64.max(p75),
        };
        let bright_neutral = neutral && bright[i] && l > 0.6f64.max(p70);
        let colour_ok = (blue[i] && l > 0.35) || bright_neutral || (warm && bright[i]);
        candidate[i] = smooth[i] && colour_ok && bright[i] && yn(i) < 0.75;
        neutral_clipped[i] = neutral && clipped;
        cloud[i] = bright[i] && soft && c < 7.0 && l > 0.72f64.max(p80);
    }
    let top: Vec<bool> = (0..n).map(|i| i < aw).collect();
    let mut seed = flood(&top, &candidate, aw, ah);
    if (count(&seed) as f64) < 0.01 * n as f64 {
        // No sky that reaches the top: windows, or no sky at all. Fall back
        // to smooth blue or clipped pixels anywhere in the upper half.
        seed = (0..n)
            .map(|i| smooth[i] && bright[i] && (blue[i] || neutral_clipped[i]) && yn(i) < 0.5)
            .collect();
        if (count(&seed) as f64) < 0.005 * n as f64 {
            return None;
        }
    }

    // The sky colour field fitted on the seed (no extrapolation below / above it).
    let seeds: Vec<usize> = (0..n).filter(|&i| seed[i]).collect();
    let seed_y: Vec<f64> = seeds.iter().map(|&i| yn(i)).collect();
    let y_lo = seed_y.iter().copied().fold(f64::INFINITY, f64::min);
    let y_hi = seed_y.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let rows: Vec<([f64; 5], [f32; 3])> = seeds
        .iter()
        .map(|&i| (design(xn(i), yn(i)), lab[i]))
        .collect();
    let coef = fit(&rows);
    let d: Vec<f32> = (0..n)
        .map(|i| distance(&lab[i], &field(&coef, xn(i), yn(i).clamp(y_lo, y_hi))))
        .collect();
    let seed_d: Vec<f32> = seeds.iter().map(|&i| d[i]).collect();
    let spread = (percentile(&seed_d, 90.0) + 1.5).min(10.0);

    let allowed: Vec<bool> = (0..n)
        .map(|i| {
            let near = (d[i] as f64) < 2.2 * spread;
            let flat = (texture[i] as f64) < 0.6 * tex_ref + 0.006;
            bright[i] && ((near && flat) || cloud[i])
        })
        .collect();
    let region = flood(&seed, &allowed, aw, ah);
    let lowest = (0..n)
        .rev()
        .find(|&i| region[i])
        .map(|i| yn(i) + 0.05)
        .unwrap_or(0.0);
    let region_f: Vec<f32> = (0..n)
        .map(|i| {
            let near = (d[i] as f64) < 0.8 * spread;
            let isolated = near && bright[i] && !region[i] && yn(i) <= lowest;
            if region[i] || isolated {
                1.0
            } else {
                0.0
            }
        })
        .collect();

    // Output size: the per-pixel field distance and the upsampled region.
    let big_lab = srgb_to_lab(&full);
    let region_up = resize(&region_f, aw, ah, 1, w0, h0);
    let mut p = Plane::new(w0, h0);
    let mut guide = Plane::new(w0, h0);
    for i in 0..w0 * h0 {
        let x = (i % w0) as f64 / (w0.max(2) - 1) as f64;
        let y = ((i / w0) as f64 / (h0.max(2) - 1) as f64).clamp(y_lo, y_hi);
        let bd = distance(&big_lab[i], &field(&coef, x, y)) as f64;
        let colour_p = ((2.0 * spread - bd) / (1.5 * spread)).clamp(0.0, 1.0) as f32;
        let r = region_up[i];
        // Inside the region trust it, near its edge let the colour decide.
        p.v[i] = if r > 0.02 && r < 0.98 {
            0.5 * r + 0.5 * colour_p
        } else {
            r
        };
        guide.v[i] = big_lab[i][0] / 100.0;
    }
    let r = ((w0.max(h0) as f64 / 256.0).round_ties_even() as usize).max(2);
    let g = guided_filter(&guide, &p, r, 1e-3);
    Some(g.v.into_iter().map(|v| v.clamp(0.0, 1.0)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small integer hash (deterministic texture for the synthetic photos).
    fn hash(x: usize, y: usize) -> u32 {
        let mut h = (x as u32).wrapping_mul(0x9e37_79b1) ^ (y as u32).wrapping_mul(0x85eb_ca77);
        h ^= h >> 15;
        h = h.wrapping_mul(0xc2b2_ae3d);
        h ^ (h >> 13)
    }

    /// The sky at height `t` (0 at the top ..= 1 at the horizon): a smooth
    /// blue, brighter at the top.
    fn sky_pixel(t: f64) -> [u8; 3] {
        let mix = |top: f64, horizon: f64| (top + (horizon - top) * t).round() as u8;
        [mix(150.0, 60.0), mix(190.0, 120.0), mix(245.0, 210.0)]
    }

    /// Textured ground (a brown noise).
    fn ground_pixel(x: usize, y: usize) -> [u8; 3] {
        let n = (hash(x, y) % 70) as u8;
        [60 + n, 55 + n / 2 + n / 4, 30 + n / 3]
    }

    /// The top half sky, the bottom half ground.
    fn sky_photo(w: usize, h: usize) -> Vec<u8> {
        (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                if y < h / 2 {
                    sky_pixel(y as f64 / (h / 2 - 1) as f64)
                } else {
                    ground_pixel(x, y)
                }
            })
            .collect()
    }

    /// Mean value of rows `rows` of a surface.
    fn mean_rows(surface: &SkySurface, rows: std::ops::Range<usize>) -> f64 {
        let w = surface.width as usize;
        let values = &surface.data[rows.start * w..rows.end * w];
        values.iter().map(|&v| v as f64).sum::<f64>() / values.len() as f64
    }

    #[test]
    fn a_smooth_blue_top_over_textured_ground_is_sky_above_and_not_below() {
        let (w, h) = (384, 256);
        let surface = estimate_sky(&sky_photo(w, h), w, h, Some(14.0)).expect("sky");
        assert_eq!((surface.width, surface.height), (w as u32, h as u32));
        assert_eq!(surface.data.len(), w * h);
        let (top, bottom) = (mean_rows(&surface, 0..100), mean_rows(&surface, 160..256));
        assert!(top > 200.0, "top {top}");
        assert!(bottom < 30.0, "bottom {bottom}");
    }

    #[test]
    fn a_flat_wall_lit_indoors_has_no_sky() {
        let (w, h) = (320, 240);
        let rgb: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let shade = (i / w * 6 / h) as u8;
                [225 - shade, 222 - shade, 216 - shade]
            })
            .collect();
        assert_eq!(estimate_sky(&rgb, w, h, Some(8.0)), None);
    }

    #[test]
    fn the_same_photo_gives_the_same_bytes() {
        let (w, h) = (384, 256);
        let rgb = sky_photo(w, h);
        assert_eq!(
            estimate_sky(&rgb, w, h, Some(14.0)),
            estimate_sky(&rgb, w, h, Some(14.0))
        );
    }

    /// Without the exposure "bright" is relative (the photo's brightest
    /// quarter): the sky's brighter top half is still found, the ground not.
    #[test]
    fn without_the_exposure_the_relative_brightness_finds_the_sky() {
        let (w, h) = (384, 256);
        let surface = estimate_sky(&sky_photo(w, h), w, h, None).expect("sky");
        let (top, bottom) = (mean_rows(&surface, 0..48), mean_rows(&surface, 160..256));
        assert!(top > 200.0, "top {top}");
        assert!(bottom < 30.0, "bottom {bottom}");
    }

    #[test]
    fn tiny_and_invalid_inputs_do_not_panic() {
        for (w, h) in [(1usize, 1usize), (2, 3), (3, 2), (1, 5)] {
            let rgb: Vec<u8> = (0..w * h * 3).map(|i| (i * 40 % 256) as u8).collect();
            for ev in [Some(14.0), Some(8.0), None] {
                if let Some(surface) = estimate_sky(&rgb, w, h, ev) {
                    assert_eq!((surface.width, surface.height), (w as u32, h as u32));
                    assert_eq!(surface.data.len(), w * h);
                }
            }
        }
        let sky = [150u8, 190, 245];
        assert_eq!(
            estimate_sky(&sky, 1, 1, Some(f64::NAN)),
            estimate_sky(&sky, 1, 1, None)
        );
        assert_eq!(estimate_sky(&[], 0, 0, None), None);
        assert_eq!(estimate_sky(&sky, 0, 1, None), None);
        assert_eq!(estimate_sky(&sky, 2, 1, None), None);
        assert_eq!(estimate_sky(&sky, usize::MAX, 2, None), None);
    }
}
