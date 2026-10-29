//! Lateral chromatic aberration found in the photo (`removeChromaticAberration`).
//!
//! The lens magnifies red and blue slightly differently from green, so an
//! edge at radius `r` in green lies at `s * r` in red (or blue): the edge's
//! radial shift is `(s - 1) * r`. [`estimate_chromatic_aberration`] measures
//! that shift on many edges and fits the line through the origin.
//!
//! 1. **Analysis image.** The photo as opened (before the geometry, the
//!    white balance and every adjustment); one longer than 2560 px is
//!    reduced to a long edge of 2560 px (Lanczos 3 in linear light, as the
//!    screen's working image), so the full-size export finds the estimate
//!    its screen found (#133).
//! 2. **Edges.** On a grid of about 640 columns, points between 20% and 97%
//!    of the half diagonal whose green gradient (on the square root, a ±2 px
//!    stencil) is at least 0.012 per pixel and points along the radius (the
//!    tangential part at most half the radial one). The 6000 strongest are
//!    kept (ties by position).
//! 3. **Shift.** Along the radius through each point, red, green and blue
//!    are sampled every half pixel over ±5 px (bilinear). Each channel's
//!    edge is the centroid of its derivative (of green's sign) over green's
//!    lobe widened by 1.5 px. An edge counts for red / blue only when green
//!    steps by at least 30% of its brighter side, the channel steps the
//!    same way by 0.25..4 times as much (a near-neutral edge), and the lobe
//!    is not cut by the window.
//! 4. **Fit.** Per channel, `shift = (s - 1) * r` through the origin:
//!    starting at the median slope, 8 rounds of Tukey's biweight (`c =
//!    4.685 x 1.4826 x MAD`, at least 0.02 px). It is kept only with at
//!    least 24 edges' worth of weight, a slope at least 3 standard errors
//!    from 0 and a shift of at least 0.25 px at the corner; else 0 (no
//!    correction: photos without edges, flat or noisy ones). The scale is
//!    held to ±1%.
//!
//! Fixed-order `f32` / `f64` arithmetic and sorting by `total_cmp` with
//! position ties only: the same photo gives the same estimate, natively and
//! in wasm.

use crate::decode::LinearImage;
use crate::resize::{fitted_size, resample, Filter};

/// The estimate of one photo: red's and blue's scale against green, minus 1
/// (0: no correction).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ChromaticEstimate {
    pub red: f64,
    pub blue: f64,
    /// Edges measured (before the fit's weights).
    pub edges: usize,
}

const ANALYSIS_LONG_EDGE: usize = 2560;
const GRID_COLUMNS: f64 = 640.0;
const MIN_RHO: f64 = 0.2;
const MAX_RHO: f64 = 0.97;
const MIN_GRADIENT: f32 = 0.012;
const MAX_TANGENTIAL: f32 = 0.5;
const MAX_EDGES: usize = 6000;
/// Profile samples on each side of the point, `STEP` px apart.
const HALF: usize = 10;
const STEP: f64 = 0.5;
const MIN_CONTRAST: f64 = 0.3;
const MIN_FIT_WEIGHT: f64 = 24.0;
const MIN_T: f64 = 3.0;
const MIN_SHIFT_PX: f64 = 0.25;
const TUKEY: f64 = 4.685;
const MIN_SCALE_PX: f64 = 0.02;

/// The analysis image: `image` itself, or reduced to a long edge of
/// [`ANALYSIS_LONG_EDGE`] (Lanczos 3 in linear light, as the screen's
/// working image is reduced): a full-size export finds the estimate its
/// screen found, whose thresholds are in pixels of that size (#133).
fn analysis_image(image: &LinearImage) -> std::borrow::Cow<'_, LinearImage> {
    let long = image.width.max(image.height);
    if long <= ANALYSIS_LONG_EDGE {
        return std::borrow::Cow::Borrowed(image);
    }
    let (w, h) = fitted_size(image.width, image.height, ANALYSIS_LONG_EDGE);
    std::borrow::Cow::Owned(LinearImage {
        width: w,
        height: h,
        data: resample(
            &image.data,
            image.width,
            image.height,
            w,
            h,
            Filter::Lanczos3,
        ),
    })
}

/// Bilinear sample of channel `c` at continuous `(x, y)` (pixel `n`'s
/// center at `n + 0.5`), clamped to the edge.
fn bilinear(image: &LinearImage, x: f64, y: f64, c: usize) -> f64 {
    let (w, h) = (image.width, image.height);
    let x = x - 0.5;
    let y = y - 0.5;
    let fx = libm::floor(x);
    let fy = libm::floor(y);
    let (tx, ty) = (x - fx, y - fy);
    let clamp = |v: f64, n: usize| (v.max(0.0) as usize).min(n - 1);
    let x0 = clamp(fx, w);
    let x1 = clamp(fx + 1.0, w);
    let y0 = clamp(fy, h);
    let y1 = clamp(fy + 1.0, h);
    let at = |x: usize, y: usize| f64::from(image.data[(y * w + x) * 3 + c]);
    let top = at(x0, y0) * (1.0 - tx) + at(x1, y0) * tx;
    let bottom = at(x0, y1) * (1.0 - tx) + at(x1, y1) * tx;
    top * (1.0 - ty) + bottom * ty
}

/// One measured edge: its radius (green's edge) and red's / blue's radial
/// shift (`None` when that channel's edge does not count).
struct Edge {
    radius: f64,
    shift: [Option<f64>; 2],
}

/// The edge of a radial profile through `(x, y)` along `u`.
fn measure(image: &LinearImage, x: f64, y: f64, u: [f64; 2], r: f64) -> Option<Edge> {
    const N: usize = 2 * HALF + 1;
    let mut profile = [[0.0f64; N]; 3];
    for k in 0..N {
        let t = (k as f64 - HALF as f64) * STEP;
        let (px, py) = (x + u[0] * t, y + u[1] * t);
        for (c, channel) in profile.iter_mut().enumerate() {
            channel[k] = bilinear(image, px, py, c);
        }
    }
    let step = |c: usize| profile[c][N - 1] - profile[c][0];
    let green = step(1);
    let brighter = profile[1][0].max(profile[1][N - 1]);
    if !(green.abs() > 1e-4 && green.abs() >= MIN_CONTRAST * brighter) {
        return None;
    }
    let sign = if green > 0.0 { 1.0 } else { -1.0 };
    let slope = |c: usize, k: usize| sign * (profile[c][k + 1] - profile[c][k - 1]);
    // Green's peak near the middle (the point is within 2 px of the edge).
    let mut peak = HALF;
    for k in HALF - 4..=HALF + 4 {
        if slope(1, k) > slope(1, peak) {
            peak = k;
        }
    }
    let top = slope(1, peak);
    if top <= 0.0 {
        return None;
    }
    let (mut lo, mut hi) = (peak, peak);
    while lo > 1 && slope(1, lo - 1) > 0.1 * top {
        lo -= 1;
    }
    while hi < N - 2 && slope(1, hi + 1) > 0.1 * top {
        hi += 1;
    }
    // Widened by 1.5 px for red's and blue's shift; a lobe that reaches the
    // window's end is cut (another edge or a soft one).
    if lo < 4 || hi > N - 5 {
        return None;
    }
    let (lo, hi) = (lo - 3, hi + 3);
    let centroid = |c: usize| {
        let (mut sum, mut moment) = (0.0, 0.0);
        for k in lo..=hi {
            let w = slope(c, k).max(0.0);
            sum += w;
            moment += w * (k as f64 - HALF as f64) * STEP;
        }
        (sum > 0.0).then(|| moment / sum)
    };
    let tg = centroid(1)?;
    let shift = [0usize, 2].map(|c| {
        let ratio = step(c) / green;
        if !(0.25..=4.0).contains(&ratio) {
            return None;
        }
        centroid(c).map(|t| t - tg).filter(|d| d.abs() < 3.0)
    });
    Some(Edge {
        radius: r + tg,
        shift,
    })
}

/// `shift = delta * radius` through the origin, robustly; 0 unless the fit
/// is significant ([`MIN_FIT_WEIGHT`], [`MIN_T`], [`MIN_SHIFT_PX`] at
/// `corner`).
fn fit(points: &[(f64, f64)], corner: f64) -> f64 {
    if (points.len() as f64) < MIN_FIT_WEIGHT {
        return 0.0;
    }
    let median = |mut v: Vec<f64>| {
        v.sort_by(f64::total_cmp);
        let n = v.len();
        if n % 2 == 1 {
            v[n / 2]
        } else {
            (v[n / 2 - 1] + v[n / 2]) / 2.0
        }
    };
    let mut delta = median(points.iter().map(|(r, d)| d / r).collect());
    let mut weights = vec![1.0f64; points.len()];
    for _ in 0..8 {
        let mad = median(points.iter().map(|(r, d)| (d - delta * r).abs()).collect());
        let c = TUKEY * (1.4826 * mad).max(MIN_SCALE_PX);
        let (mut num, mut den) = (0.0, 0.0);
        for (w, (r, d)) in weights.iter_mut().zip(points) {
            let e = (d - delta * r) / c;
            *w = if e.abs() < 1.0 {
                let q = 1.0 - e * e;
                q * q
            } else {
                0.0
            };
            num += *w * r * d;
            den += *w * r * r;
        }
        if den <= 0.0 {
            return 0.0;
        }
        delta = num / den;
    }
    let (mut n, mut rr, mut ee) = (0.0, 0.0, 0.0);
    for (w, (r, d)) in weights.iter().zip(points) {
        let e = d - delta * r;
        n += w;
        rr += w * r * r;
        ee += w * e * e;
    }
    if n < MIN_FIT_WEIGHT || rr <= 0.0 {
        return 0.0;
    }
    let se = libm::sqrt(ee / (n - 1.0) / rr);
    if delta.abs() < MIN_T * se || delta.abs() * corner < MIN_SHIFT_PX {
        return 0.0;
    }
    delta.clamp(-super::MAX_CHROMATIC_SCALE, super::MAX_CHROMATIC_SCALE)
}

/// The lateral chromatic aberration of `image` (the photo as opened, linear
/// RGB). See the module docs.
pub fn estimate_chromatic_aberration(image: &LinearImage) -> ChromaticEstimate {
    if image.width < 32 || image.height < 32 {
        return ChromaticEstimate::default();
    }
    let image = analysis_image(image);
    let image = image.as_ref();
    let (w, h) = (image.width, image.height);
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let corner = libm::hypot(w as f64, h as f64) / 2.0;
    let green = |x: usize, y: usize| image.data[(y * w + x) * 3 + 1].max(0.0).sqrt();
    let grid = (libm::round(w.max(h) as f64 / GRID_COLUMNS) as usize).max(2);
    let mut candidates: Vec<(f32, usize, usize)> = Vec::new();
    for y in (3..h - 3).step_by(grid) {
        for x in (3..w - 3).step_by(grid) {
            let (dx, dy) = (x as f64 + 0.5 - cx, y as f64 + 0.5 - cy);
            let r = libm::hypot(dx, dy);
            let rho = r / corner;
            if !(MIN_RHO..=MAX_RHO).contains(&rho) {
                continue;
            }
            let (ux, uy) = ((dx / r) as f32, (dy / r) as f32);
            let gx = (green(x + 2, y) - green(x - 2, y)) * 0.25;
            let gy = (green(x, y + 2) - green(x, y - 2)) * 0.25;
            let radial = gx * ux + gy * uy;
            let tangential = -gx * uy + gy * ux;
            if radial.abs() < MIN_GRADIENT || tangential.abs() > MAX_TANGENTIAL * radial.abs() {
                continue;
            }
            candidates.push((radial.abs(), x, y));
        }
    }
    if candidates.len() > MAX_EDGES {
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.2.cmp(&b.2)).then(a.1.cmp(&b.1)));
        candidates.truncate(MAX_EDGES);
    }
    let mut red = Vec::new();
    let mut blue = Vec::new();
    let mut edges = 0;
    for &(_, x, y) in &candidates {
        let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
        let (dx, dy) = (px - cx, py - cy);
        let r = libm::hypot(dx, dy);
        let Some(edge) = measure(image, px, py, [dx / r, dy / r], r) else {
            continue;
        };
        edges += 1;
        if let Some(d) = edge.shift[0] {
            red.push((edge.radius, d));
        }
        if let Some(d) = edge.shift[1] {
            blue.push((edge.radius, d));
        }
    }
    ChromaticEstimate {
        red: fit(&red, corner),
        blue: fit(&blue, corner),
        edges,
    }
}
