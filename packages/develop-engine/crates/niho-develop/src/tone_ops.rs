//! Stage P point operations: a port of Photo Bench `ToneOps.swift` (itself a
//! port of `.photobench/phase2/tone/tone_model.py`) plus `RGBTone` /
//! `DNGSpline` from `RGBTone.swift`. Every constant is transcribed verbatim.
//!
//! All functions take and return **linear ProPhoto** `[f64; 3]` and are exact
//! no-ops at their neutral value. They are evaluated on the 64^3 cube grid
//! (`lut.rs`), not per pixel, exactly like Photo Bench's cube P.

use crate::color::{srgb_decode, srgb_decode_fast, srgb_encode, srgb_encode_fast, PP_LUMA};
use crate::settings::{CurveChannel, CurvePoint, DevelopSettings, ToneCurve};

pub type Rgb = [f64; 3];

// Preserve the verbatim frozen R131 coefficients used by the R236 pipeline.
#[allow(clippy::excessive_precision)]
const NIHO3_BLACKS_A_LINEAR: f64 = -0.086910896459824319;
#[allow(clippy::excessive_precision)]
const NIHO3_BLACKS_A_QUADRATIC: f64 = 0.035765089727158451;
#[allow(clippy::excessive_precision)]
const NIHO3_BLACKS_BETA: f64 = 0.31512250313115842;

#[inline]
fn pow(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}

/// `tone_model._power_ratio`.
#[inline]
fn power_ratio(u: f64, a: f64, c: f64) -> f64 {
    let ua = pow(u.max(1e-12), a);
    let oa = pow((1.0 - u).max(1e-12), a);
    ua / (ua + c * oa)
}

/// `np.interp` (clamped to the end values outside the knots).
pub(crate) fn piecewise_linear(x: f64, xs: &[f64], ys: &[f64]) -> f64 {
    if x <= xs[0] {
        return ys[0];
    }
    let last = xs.len() - 1;
    if x >= xs[last] {
        return ys[last];
    }
    for index in 1..=last {
        if x <= xs[index] {
            let t = (x - xs[index - 1]) / (xs[index] - xs[index - 1]);
            return ys[index - 1] + (ys[index] - ys[index - 1]) * t;
        }
    }
    ys[last]
}

/// `RefBaselineRGBTone`: hue-preserving tone curve on `[0,1]`-pinned RGB.
pub fn rgb_tone(rgb: Rgb, curve: &dyn Fn(f64) -> f64) -> Rgb {
    let r = rgb[0].clamp(0.0, 1.0);
    let g = rgb[1].clamp(0.0, 1.0);
    let b = rgb[2].clamp(0.0, 1.0);
    let mix = |hi: f64, mid: f64, lo: f64| -> (f64, f64, f64) {
        let hi_out = curve(hi);
        let lo_out = curve(lo);
        let denom = hi - lo;
        let mid_out = if denom > 0.0 {
            lo_out + (hi_out - lo_out) * (mid - lo) / denom
        } else {
            hi_out
        };
        (hi_out, mid_out, lo_out)
    };
    if r >= g {
        if g > b {
            let (h, m, l) = mix(r, g, b);
            [h, m, l]
        } else if b > r {
            let (h, m, l) = mix(b, r, g);
            [m, l, h]
        } else if b > g {
            let (h, m, l) = mix(r, b, g);
            [h, l, m]
        } else {
            let rr = curve(r);
            let gg = curve(g);
            [rr, gg, gg]
        }
    } else if r >= b {
        let (h, m, l) = mix(g, r, b);
        [m, h, l]
    } else if b > g {
        let (h, m, l) = mix(b, g, r);
        [l, m, h]
    } else {
        let (h, m, l) = mix(g, b, r);
        [l, h, m]
    }
}

/// `RGBTone.applyEncoded` with sRGB encode/decode (`ToneOps.encodedCurve`).
pub fn encoded_curve(value: Rgb, curve: &dyn Fn(f64) -> f64) -> Rgb {
    let encoded = [
        srgb_encode(value[0].clamp(0.0, 1.0)),
        srgb_encode(value[1].clamp(0.0, 1.0)),
        srgb_encode(value[2].clamp(0.0, 1.0)),
    ];
    let curved = rgb_tone(encoded, curve);
    [
        srgb_decode(curved[0]),
        srgb_decode(curved[1]),
        srgb_decode(curved[2]),
    ]
}

// MARK: - Exposure2012 (non-RAW only)

const EXPOSURE_EV: [f64; 6] = [-2.0, -1.0, 0.0, 1.0, 2.0, 3.0];
const EXPOSURE_M: [f64; 6] = [0.5503, 0.9715, 1.0000, 1.0077, 1.0012, 1.0017];
const EXPOSURE_A: [f64; 6] = [0.9836, 0.9777, 1.0000, 1.0245, 1.0514, 1.1313];
const EXPOSURE_C: [f64; 6] = [4.5684, 2.9495, 1.0000, 0.3214, 0.0999, 0.0256];

fn exposure_gray_curve_linear(x: f64, ev: f64) -> f64 {
    let ev = ev.clamp(EXPOSURE_EV[0], EXPOSURE_EV[5]);
    let m = piecewise_linear(ev, &EXPOSURE_EV, &EXPOSURE_M);
    let a = piecewise_linear(ev, &EXPOSURE_EV, &EXPOSURE_A);
    let c = piecewise_linear(ev, &EXPOSURE_EV, &EXPOSURE_C);
    (m * power_ratio(x, a, c)).clamp(0.0, 1.0)
}

/// `tone_model.apply_exposure` (non-RAW input only).
pub fn exposure_non_raw(value: Rgb, ev: f64) -> Rgb {
    if ev == 0.0 {
        return value;
    }
    encoded_curve(value, &|v| {
        srgb_encode(exposure_gray_curve_linear(srgb_decode(v), ev))
    })
}

// MARK: - Contrast2012

const CONTRAST_K: f64 = 0.419;

pub fn contrast(value: Rgb, amount: f64) -> Rgb {
    if amount == 0.0 {
        return value;
    }
    let e = libm::exp(CONTRAST_K * (amount / 100.0).clamp(-1.0, 1.0));
    encoded_curve(value, &|u| power_ratio(u, e, 1.0))
}

// MARK: - Dehaze (pointwise)

fn grid29() -> [f64; 29] {
    let mut g = [0.0; 29];
    for (i, v) in g.iter_mut().enumerate() {
        *v = -14.0 + i as f64 * 0.5;
    }
    g
}

#[rustfmt::skip]
const DEHAZE_GAIN_50_POS: [f64; 29] = [
    -0.9862, -0.9862, -0.9862, -0.9862, -0.9862, -0.9862, -0.9862, -0.9862, -0.9862, -0.9862,
    -0.9862, -0.9862, -0.9862, -0.9862, -0.9862, -0.9862, -0.9862, -0.996347, -1.034678, -1.045433,
    -1.033353, -1.011323, -0.992833, -0.956357, -0.887950, -0.728754, -0.435554, -0.3194, -0.3194,
];
#[rustfmt::skip]
const DEHAZE_GAIN_50_NEG: [f64; 29] = [
    1.7478, 1.7478, 1.7478, 1.7478, 1.7478, 1.7478, 1.7478, 1.7478, 1.7478, 1.7478,
    1.7478, 1.7478, 1.7478, 1.7478, 1.7478, 1.7478, 1.7478, 1.732147, 1.654377, 1.574631,
    1.498939, 1.422737, 1.309562, 1.139466, 0.919832, 0.681691, 0.422810, 0.2216, 0.2216,
];
const DEHAZE_TONE_POS_XS: [f64; 4] = [0.0, 20.0, 50.0, 80.0];
const DEHAZE_TONE_POS_YS: [f64; 4] = [0.0, 0.216, 1.0, 1.237];
const DEHAZE_TONE_NEG_XS: [f64; 3] = [0.0, 40.0, 50.0];
const DEHAZE_TONE_NEG_YS: [f64; 3] = [0.0, 0.840, 1.0];
const DEHAZE_KSAT_XS: [f64; 5] = [-40.0, 0.0, 20.0, 40.0, 80.0];
const DEHAZE_KSAT_MINUS1_YS: [f64; 5] = [-0.3503, 0.0, 0.1027, 0.4693, 0.5805];
const DEHAZE_EPS: f64 = 3e-5;

fn dehaze_tone_scale(amount: f64) -> f64 {
    if amount >= 0.0 {
        piecewise_linear(amount, &DEHAZE_TONE_POS_XS, &DEHAZE_TONE_POS_YS)
    } else {
        piecewise_linear(-amount, &DEHAZE_TONE_NEG_XS, &DEHAZE_TONE_NEG_YS)
    }
}

/// Dehaze with its amount-dependent curve and saturation factor computed
/// once (cube bakes).
#[derive(Debug, Clone)]
pub struct PreparedDehaze {
    curve: [f64; 29],
    k_sat: f64,
}

impl PreparedDehaze {
    pub fn new(amount: f64) -> Option<Self> {
        if amount == 0.0 {
            return None;
        }
        let table = if amount > 0.0 {
            &DEHAZE_GAIN_50_POS
        } else {
            &DEHAZE_GAIN_50_NEG
        };
        let scale = dehaze_tone_scale(amount);
        let mut curve = [0.0; 29];
        for (dst, src) in curve.iter_mut().zip(table.iter()) {
            *dst = src * scale;
        }
        Some(Self {
            curve,
            k_sat: 1.0 + piecewise_linear(amount, &DEHAZE_KSAT_XS, &DEHAZE_KSAT_MINUS1_YS),
        })
    }

    pub fn apply(&self, value: Rgb) -> Rgb {
        let luma = |v: Rgb| v[0] * PP_LUMA[0] + v[1] * PP_LUMA[1] + v[2] * PP_LUMA[2];
        let ln0 = libm::log2(luma(value).max(DEHAZE_EPS));
        // np.interp on the uniform grid -14..0 (step 0.5), clamped.
        let gain = if ln0 <= -14.0 {
            self.curve[0]
        } else if ln0 >= 0.0 {
            self.curve[28]
        } else {
            let pos = (ln0 + 14.0) * 2.0;
            let i = (pos as usize).min(27);
            let t = pos - i as f64;
            self.curve[i] + (self.curve[i + 1] - self.curve[i]) * t
        };
        let factor = libm::exp2(gain);
        let toned = [value[0] * factor, value[1] * factor, value[2] * factor];
        let y1 = luma(toned);
        [
            (y1 + (toned[0] - y1) * self.k_sat).max(0.0),
            (y1 + (toned[1] - y1) * self.k_sat).max(0.0),
            (y1 + (toned[2] - y1) * self.k_sat).max(0.0),
        ]
    }
}

/// `apply_dehaze`: global log2-luminance curve plus saturation (linear).
pub fn dehaze(value: Rgb, amount: f64) -> Rgb {
    if amount == 0.0 {
        return value;
    }
    let luma = |v: Rgb| v[0] * PP_LUMA[0] + v[1] * PP_LUMA[1] + v[2] * PP_LUMA[2];
    let y0 = luma(value).max(DEHAZE_EPS);
    let ln0 = libm::log2(y0);
    let table = if amount > 0.0 {
        &DEHAZE_GAIN_50_POS
    } else {
        &DEHAZE_GAIN_50_NEG
    };
    let scale = dehaze_tone_scale(amount);
    let mut curve = [0.0; 29];
    for (dst, src) in curve.iter_mut().zip(table.iter()) {
        *dst = src * scale;
    }
    let gain = piecewise_linear(ln0, &grid29(), &curve);
    let factor = libm::exp2(gain);
    let toned = [value[0] * factor, value[1] * factor, value[2] * factor];
    let k_sat = 1.0 + piecewise_linear(amount, &DEHAZE_KSAT_XS, &DEHAZE_KSAT_MINUS1_YS);
    let y1 = luma(toned);
    [
        (y1 + (toned[0] - y1) * k_sat).max(0.0),
        (y1 + (toned[1] - y1) * k_sat).max(0.0),
        (y1 + (toned[2] - y1) * k_sat).max(0.0),
    ]
}

// MARK: - Whites2012 / Blacks2012

const WHITES_AMOUNT: [f64; 5] = [-100.0, -50.0, 0.0, 50.0, 100.0];
const WHITES_M: [f64; 5] = [0.9276, 0.9809, 1.0, 1.0616, 1.1346];
const WHITES_A: [f64; 5] = [0.9128, 0.9262, 1.0, 1.0663, 1.3269];
const WHITES_C: [f64; 5] = [1.0134, 1.0865, 1.0, 0.9499, 0.5667];
const BLACKS_M: [f64; 5] = [1.2659, 1.0672, 1.0, 1.0037, 1.0085];
const BLACKS_A: [f64; 5] = [1.0711, 1.0050, 1.0, 0.9393, 0.8775];
const BLACKS_C: [f64; 5] = [1.0421, 0.9740, 1.0, 0.8579, 0.7453];
const WHITES_BETA_NEGATIVE: f64 = 0.4;
const WHITES_KAPPA_NEGATIVE: f64 = 0.25;
const WHITES_BETA_POSITIVE: f64 = 0.4;
const BLACKS_BETA_POSITIVE: f64 = 0.4;
const BLACKS_BETA_NEGATIVE: f64 = 1.0;

fn anchored_ratio(u: f64, anchor: f64, m: f64, a: f64, c: f64) -> f64 {
    (anchor + m * (power_ratio(u, a, c) - anchor)).clamp(0.0, 1.0)
}

/// `tone_model._rgbtone_mixed_with_luminance_ratio`.
fn rgb_tone_mixed_with_luminance_ratio(
    value: Rgb,
    beta: f64,
    kappa: f64,
    curve: &dyn Fn(f64) -> f64,
) -> Rgb {
    let tone = encoded_curve(value, curve);
    if beta >= 1.0 {
        return tone;
    }
    let clipped = [value[0].max(0.0), value[1].max(0.0), value[2].max(0.0)];
    let y = (clipped[0] * PP_LUMA[0] + clipped[1] * PP_LUMA[1] + clipped[2] * PP_LUMA[2]).max(1e-6);
    let mut gain = srgb_decode(curve(srgb_encode(y))) / y;
    if gain > 1.0 {
        let largest = clipped[0].max(clipped[1]).max(clipped[2].max(1e-6));
        gain = gain.min((1.0 / largest).max(1.0));
    }
    let ratio: Rgb = if kappa == 1.0 {
        [clipped[0] * gain, clipped[1] * gain, clipped[2] * gain]
    } else {
        let k = pow(gain, kappa);
        let yg = y * gain;
        [
            (yg + (clipped[0] - y) * k).max(0.0),
            (yg + (clipped[1] - y) * k).max(0.0),
            (yg + (clipped[2] - y) * k).max(0.0),
        ]
    };
    [
        ratio[0] + beta * (tone[0] - ratio[0]),
        ratio[1] + beta * (tone[1] - ratio[1]),
        ratio[2] + beta * (tone[2] - ratio[2]),
    ]
}

pub fn whites(value: Rgb, amount: f64) -> Rgb {
    if amount == 0.0 {
        return value;
    }
    let m = piecewise_linear(amount, &WHITES_AMOUNT, &WHITES_M);
    let a = piecewise_linear(amount, &WHITES_AMOUNT, &WHITES_A);
    let c = piecewise_linear(amount, &WHITES_AMOUNT, &WHITES_C);
    let curve = move |u: f64| anchored_ratio(u, 0.0, m, a, c);
    if amount < 0.0 {
        rgb_tone_mixed_with_luminance_ratio(
            value,
            WHITES_BETA_NEGATIVE,
            WHITES_KAPPA_NEGATIVE,
            &curve,
        )
    } else {
        rgb_tone_mixed_with_luminance_ratio(value, WHITES_BETA_POSITIVE, 1.0, &curve)
    }
}

pub fn blacks(value: Rgb, amount: f64) -> Rgb {
    if amount == 0.0 {
        return value;
    }
    let m = piecewise_linear(amount, &WHITES_AMOUNT, &BLACKS_M);
    let a = piecewise_linear(amount, &WHITES_AMOUNT, &BLACKS_A);
    let c = piecewise_linear(amount, &WHITES_AMOUNT, &BLACKS_C);
    let beta = if amount > 0.0 {
        BLACKS_BETA_POSITIVE
    } else {
        BLACKS_BETA_NEGATIVE
    };
    rgb_tone_mixed_with_luminance_ratio(value, beta, 1.0, &move |u: f64| {
        anchored_ratio(u, 1.0, m, a, c)
    })
}

// MARK: - Parametric

fn asym_cosine_window(x: f64, peak: f64, left: f64, right: f64) -> f64 {
    let pi = core::f64::consts::PI;
    if x < peak {
        if peak <= left {
            return 0.0;
        }
        let t = ((x - peak) / (peak - left)).clamp(-1.0, 0.0);
        pow(libm::cos(t * pi / 2.0), 2.0)
    } else {
        if right <= peak {
            return 0.0;
        }
        let t = ((x - peak) / (right - peak)).clamp(0.0, 1.0);
        pow(libm::cos(t * pi / 2.0), 2.0)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Parametric {
    pub shadows: f64,
    pub darks: f64,
    pub lights: f64,
    pub highlights: f64,
    pub shadow_split: f64,
    pub midtone_split: f64,
    pub highlight_split: f64,
}

/// The parametric gray curve in the sRGB-encoded domain.
fn parametric_gray(v: f64, p: &Parametric) -> f64 {
    let ss = p.shadow_split / 100.0;
    let ms = p.midtone_split / 100.0;
    let hs = p.highlight_split / 100.0;
    let scale = |amount: f64, delta: f64| (amount / 60.0) * delta;
    let mut out = v;
    if p.shadows != 0.0 {
        let pd = scale(p.shadows, if p.shadows > 0.0 { 0.0541 } else { 0.0617 });
        out += pd * asym_cosine_window(v, ss, 0.0, ms);
    }
    if p.darks != 0.0 {
        let pd = scale(p.darks, if p.darks > 0.0 { 0.1025 } else { 0.1147 });
        out += pd * asym_cosine_window(v, ms, 0.0, 1.0);
    }
    if p.lights != 0.0 {
        let pd = scale(p.lights, if p.lights > 0.0 { 0.1632 } else { 0.1249 });
        out += pd * asym_cosine_window(v, hs, 0.0, 1.0);
    }
    if p.highlights != 0.0 {
        let peak = hs + 0.36 * (1.0 - hs);
        let pd = scale(
            p.highlights,
            if p.highlights > 0.0 { 0.0871 } else { 0.0774 },
        );
        out += pd * asym_cosine_window(v, peak, ms, 1.0);
    }
    out.clamp(0.0, 1.0)
}

pub fn parametric(value: Rgb, p: &Parametric) -> Rgb {
    if p.shadows == 0.0 && p.darks == 0.0 && p.lights == 0.0 && p.highlights == 0.0 {
        return value;
    }
    let p = *p;
    encoded_curve(value, &move |v: f64| parametric_gray(v, &p))
}

// MARK: - DNG spline and point curves

/// `dng_spline_solver` (flat extension beyond the end points).
#[derive(Debug, Clone)]
pub struct DngSpline {
    x: Vec<f64>,
    y: Vec<f64>,
    s: Vec<f64>,
}

impl DngSpline {
    /// `None` for fewer than 2 points or non-increasing x (like the SDK).
    pub fn new(points: &[(f64, f64)]) -> Option<Self> {
        let mut sorted = points.to_vec();
        sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
        if sorted.len() < 2 {
            return None;
        }
        let x: Vec<f64> = sorted.iter().map(|p| p.0).collect();
        let y: Vec<f64> = sorted.iter().map(|p| p.1).collect();
        for k in 1..x.len() {
            if x[k] <= x[k - 1] {
                return None;
            }
        }
        let s = Self::solve(&x, &y);
        Some(Self { x, y, s })
    }

    fn solve(x: &[f64], y: &[f64]) -> Vec<f64> {
        let count = x.len();
        let mut s = vec![0.0; count];
        let mut a = x[1] - x[0];
        let mut b = (y[1] - y[0]) / a;
        s[0] = b;
        let mut j = 2;
        while j < count {
            let c = x[j] - x[j - 1];
            let d = (y[j] - y[j - 1]) / c;
            s[j - 1] = (b * c + d * a) / (a + c);
            a = c;
            b = d;
            j += 1;
        }
        s[count - 1] = 2.0 * b - s[count - 2];
        s[0] = 2.0 * s[0] - s[1];
        if count <= 2 {
            return s;
        }
        let mut e = vec![0.0; count];
        let mut f = vec![0.0; count];
        let mut g = vec![0.0; count];
        f[0] = 0.5;
        e[count - 1] = 0.5;
        g[0] = 0.75 * (s[0] + s[1]);
        g[count - 1] = 0.75 * (s[count - 2] + s[count - 1]);
        for j in 1..(count - 1) {
            let aj = (x[j + 1] - x[j - 1]) * 2.0;
            e[j] = (x[j + 1] - x[j]) / aj;
            f[j] = (x[j] - x[j - 1]) / aj;
            g[j] = 1.5 * s[j];
        }
        for j in 1..count {
            let aj = 1.0 - f[j - 1] * e[j];
            if j != count - 1 {
                f[j] /= aj;
            }
            g[j] = (g[j] - g[j - 1] * e[j]) / aj;
        }
        let mut j2 = count as isize - 2;
        while j2 >= 0 {
            let j = j2 as usize;
            g[j] -= f[j] * g[j + 1];
            j2 -= 1;
        }
        g
    }

    pub fn evaluate(&self, x_val: f64) -> f64 {
        let count = self.x.len();
        if x_val <= self.x[0] {
            return self.y[0];
        }
        if x_val >= self.x[count - 1] {
            return self.y[count - 1];
        }
        let mut lower = 1;
        let mut upper = count - 1;
        while upper > lower {
            let mid = (lower + upper) >> 1;
            if x_val == self.x[mid] {
                return self.y[mid];
            }
            if x_val > self.x[mid] {
                lower = mid + 1;
            } else {
                upper = mid;
            }
        }
        let j = lower;
        let (x0, y0, s0) = (self.x[j - 1], self.y[j - 1], self.s[j - 1]);
        let (x1, y1, s1) = (self.x[j], self.y[j], self.s[j]);
        let a = x1 - x0;
        let b = (x_val - x0) / a;
        let c = (x1 - x_val) / a;
        (y0 * (2.0 - c + b) + (s0 * a * b)) * (c * c)
            + (y1 * (2.0 - b + c) - (s1 * a * c)) * (b * b)
    }
}

/// `ToneCurveModel.normalizedPoints`: finite points clamped to `[0,1]`,
/// sorted by x, duplicate x (within 1e-6) resolved last-authored-wins;
/// empty when fewer than 2 points remain.
pub fn normalized_points(curve: &ToneCurve) -> Vec<CurvePoint> {
    let mut finite: Vec<(usize, CurvePoint)> = curve
        .points
        .iter()
        .enumerate()
        .filter(|(_, p)| p.x.is_finite() && p.y.is_finite())
        .map(|(i, p)| {
            (
                i,
                CurvePoint {
                    x: p.x.clamp(0.0, 1.0),
                    y: p.y.clamp(0.0, 1.0),
                },
            )
        })
        .collect();
    finite.sort_by(|a, b| a.1.x.total_cmp(&b.1.x));
    let mut result: Vec<(usize, CurvePoint)> = Vec::new();
    for candidate in finite {
        if let Some(last) = result.last_mut() {
            if (last.1.x - candidate.1.x).abs() < 0.000_001 {
                if candidate.0 > last.0 {
                    *last = candidate;
                }
                continue;
            }
        }
        result.push(candidate);
    }
    if result.len() >= 2 {
        result.into_iter().map(|(_, p)| p).collect()
    } else {
        Vec::new()
    }
}

/// `ToneCurveModel.isIdentity` over a list of curves.
pub fn curves_are_identity(curves: &[ToneCurve], tolerance: f64) -> bool {
    curves.iter().all(|curve| {
        normalized_points(curve)
            .iter()
            .all(|p| (p.x - p.y).abs() <= tolerance)
    })
}

/// `ToneOps.PreparedPointCurve`: composite curve (hue preserving, encoded)
/// first, then single-channel R/G/B curves.
#[derive(Debug, Clone, Default)]
pub struct PreparedPointCurve {
    composite: Option<DngSpline>,
    red: Option<DngSpline>,
    green: Option<DngSpline>,
    blue: Option<DngSpline>,
}

impl PreparedPointCurve {
    pub fn new(curves: &[ToneCurve]) -> Self {
        let spline = |channel: CurveChannel| -> Option<DngSpline> {
            let curve = curves.iter().find(|c| c.channel == channel)?;
            let points = normalized_points(curve);
            if points.len() < 2 {
                return None;
            }
            let pairs: Vec<(f64, f64)> = points.iter().map(|p| (p.x, p.y)).collect();
            DngSpline::new(&pairs)
        };
        Self {
            composite: spline(CurveChannel::Rgb),
            red: spline(CurveChannel::Red),
            green: spline(CurveChannel::Green),
            blue: spline(CurveChannel::Blue),
        }
    }

    pub fn apply(&self, value: Rgb) -> Rgb {
        let mut result = value;
        if let Some(composite) = &self.composite {
            result = encoded_curve(result, &|v| composite.evaluate(v).clamp(0.0, 1.0));
        }
        for (index, spline) in [(0, &self.red), (1, &self.green), (2, &self.blue)] {
            if let Some(spline) = spline {
                let encoded = srgb_encode(result[index].clamp(0.0, 1.0));
                let curved = spline.evaluate(encoded).clamp(0.0, 1.0);
                result[index] = srgb_decode(curved);
            }
        }
        result
    }
}

/// A gray curve `[0,1] -> [0,1]` sampled on 4096 intervals (linear
/// interpolation). Cube bakes evaluate every curve twice per grid point;
/// sampling it once per bake is ~10x faster, and the interpolation error
/// (< 1e-6 away from kinks) disappears in the 8-bit cube entries.
#[derive(Debug, Clone)]
pub struct CurveTable(Vec<f64>);

const CURVE_TABLE_INTERVALS: usize = 4096;

impl CurveTable {
    pub fn new(f: &dyn Fn(f64) -> f64) -> Self {
        Self(
            (0..=CURVE_TABLE_INTERVALS)
                .map(|i| f(i as f64 / CURVE_TABLE_INTERVALS as f64))
                .collect(),
        )
    }

    #[inline]
    pub fn eval(&self, x: f64) -> f64 {
        let pos = x.clamp(0.0, 1.0) * CURVE_TABLE_INTERVALS as f64;
        let i = (pos as usize).min(CURVE_TABLE_INTERVALS - 1);
        let t = pos - i as f64;
        self.0[i] + (self.0[i + 1] - self.0[i]) * t
    }
}

/// [`encoded_curve`] with a sampled curve and table-based sRGB transfer.
#[inline]
fn encoded_curve_table(value: Rgb, curve: &CurveTable) -> Rgb {
    let encoded = [
        srgb_encode_fast(value[0].clamp(0.0, 1.0)),
        srgb_encode_fast(value[1].clamp(0.0, 1.0)),
        srgb_encode_fast(value[2].clamp(0.0, 1.0)),
    ];
    let curved = rgb_tone(encoded, &|x| curve.eval(x));
    [
        srgb_decode_fast(curved[0]),
        srgb_decode_fast(curved[1]),
        srgb_decode_fast(curved[2]),
    ]
}

/// Whites / Blacks anchored power-ratio parameters.
#[derive(Debug, Clone, Copy)]
struct Anchored {
    anchor: f64,
    m: f64,
    a: f64,
    c: f64,
}

impl Anchored {
    fn eval(&self, u: f64) -> f64 {
        anchored_ratio(u, self.anchor, self.m, self.a, self.c)
    }
}

/// The luminance gain `decode(curve(encode(Y))) / Y` of Whites / Blacks,
/// sampled on `log2 Y` in `[-20, 0]` (the gain is smooth there; `Y` is
/// floored at 1e-6 = 2^-19.93). Built from the direct curve: a sampled
/// curve's first interval would not tend to 0 like `u^a`.
#[derive(Debug, Clone)]
struct GainTable(Vec<f64>);

const GAIN_TABLE_INTERVALS: usize = 4096;
const GAIN_TABLE_MIN_LOG2: f64 = -20.0;

impl GainTable {
    fn new(direct: Anchored) -> Self {
        Self(
            (0..=GAIN_TABLE_INTERVALS)
                .map(|i| {
                    let l = GAIN_TABLE_MIN_LOG2 * (1.0 - i as f64 / GAIN_TABLE_INTERVALS as f64);
                    let y = libm::exp2(l);
                    srgb_decode(direct.eval(srgb_encode(y))) / y
                })
                .collect(),
        )
    }

    #[inline]
    fn eval(&self, y: f64, direct: Anchored) -> f64 {
        if y > 1.0 {
            return srgb_decode(direct.eval(srgb_encode(y))) / y;
        }
        let pos = ((libm::log2(y) - GAIN_TABLE_MIN_LOG2) / -GAIN_TABLE_MIN_LOG2
            * GAIN_TABLE_INTERVALS as f64)
            .max(0.0);
        let i = (pos as usize).min(GAIN_TABLE_INTERVALS - 1);
        let t = pos - i as f64;
        self.0[i] + (self.0[i + 1] - self.0[i]) * t
    }
}

/// [`rgb_tone_mixed_with_luminance_ratio`] with sampled curves.
fn mixed_table(
    value: Rgb,
    beta: f64,
    kappa: f64,
    curve: &CurveTable,
    gains: &GainTable,
    direct: Anchored,
) -> Rgb {
    let tone = encoded_curve_table(value, curve);
    if beta >= 1.0 {
        return tone;
    }
    let clipped = [value[0].max(0.0), value[1].max(0.0), value[2].max(0.0)];
    let y = (clipped[0] * PP_LUMA[0] + clipped[1] * PP_LUMA[1] + clipped[2] * PP_LUMA[2]).max(1e-6);
    let mut gain = gains.eval(y, direct);
    if gain > 1.0 {
        let largest = clipped[0].max(clipped[1]).max(clipped[2].max(1e-6));
        gain = gain.min((1.0 / largest).max(1.0));
    }
    let ratio: Rgb = if kappa == 1.0 {
        [clipped[0] * gain, clipped[1] * gain, clipped[2] * gain]
    } else {
        let k = pow(gain, kappa);
        let yg = y * gain;
        [
            (yg + (clipped[0] - y) * k).max(0.0),
            (yg + (clipped[1] - y) * k).max(0.0),
            (yg + (clipped[2] - y) * k).max(0.0),
        ]
    };
    [
        ratio[0] + beta * (tone[0] - ratio[0]),
        ratio[1] + beta * (tone[1] - ratio[1]),
        ratio[2] + beta * (tone[2] - ratio[2]),
    ]
}

/// Stage P for one settings value, every gray curve sampled once: what a
/// cube bake evaluates on each grid point. Same operations in the same
/// order as the direct functions above (`exposureNonRaw` first when
/// non-zero, then Contrast -> Dehaze -> Whites -> Blacks -> Parametric ->
/// Point curve).
#[derive(Debug, Clone)]
pub struct PreparedPostOps {
    exposure: Option<CurveTable>,
    contrast: Option<CurveTable>,
    dehaze: Option<PreparedDehaze>,
    whites: Option<(CurveTable, GainTable, Anchored, f64, f64)>,
    blacks: Option<(CurveTable, GainTable, Anchored, f64)>,
    parametric: Option<CurveTable>,
    point: Option<CurveTable>,
    channels: [Option<CurveTable>; 3],
    /// NIHO standard look's tone, last in cube P (RAW only).
    look: Option<CurveTable>,
}

impl PreparedPostOps {
    pub fn new(settings: &DevelopSettings) -> Self {
        Self::with_exposure(settings, 0.0)
    }

    /// `exposure_non_raw_ev != 0` prepends the non-RAW exposure (cube P of
    /// JPEG / PNG input).
    pub fn with_exposure(settings: &DevelopSettings, exposure_non_raw_ev: f64) -> Self {
        let exposure = (exposure_non_raw_ev != 0.0).then(|| {
            let ev = exposure_non_raw_ev;
            CurveTable::new(&move |v| srgb_encode(exposure_gray_curve_linear(srgb_decode(v), ev)))
        });
        let contrast = (settings.contrast != 0.0).then(|| {
            let e = libm::exp(CONTRAST_K * (settings.contrast / 100.0).clamp(-1.0, 1.0));
            CurveTable::new(&move |u| power_ratio(u, e, 1.0))
        });
        let whites = (settings.whites != 0.0).then(|| {
            let amount = settings.whites;
            let m = piecewise_linear(amount, &WHITES_AMOUNT, &WHITES_M);
            let a = piecewise_linear(amount, &WHITES_AMOUNT, &WHITES_A);
            let c = piecewise_linear(amount, &WHITES_AMOUNT, &WHITES_C);
            let direct = Anchored {
                anchor: 0.0,
                m,
                a,
                c,
            };
            let table = CurveTable::new(&move |u| direct.eval(u));
            let gains = GainTable::new(direct);
            if amount < 0.0 {
                (
                    table,
                    gains,
                    direct,
                    WHITES_BETA_NEGATIVE,
                    WHITES_KAPPA_NEGATIVE,
                )
            } else {
                (table, gains, direct, WHITES_BETA_POSITIVE, 1.0)
            }
        });
        let blacks = (settings.blacks != 0.0).then(|| {
            let amount = settings.blacks;
            let m = piecewise_linear(amount, &WHITES_AMOUNT, &BLACKS_M);
            let mut a = piecewise_linear(amount, &WHITES_AMOUNT, &BLACKS_A);
            let mut c = piecewise_linear(amount, &WHITES_AMOUNT, &BLACKS_C);
            // `niho-6` (JPEG / PNG, #18397 R18) takes the RAW positive Blacks
            // too: with the presets' exposure and black-lifting curves the
            // Photo Bench curve leaves the shadows 3-5 L* darker than
            // Lightroom's JPEG export.
            let niho3_positive = matches!(
                settings.engine.as_str(),
                crate::settings::ENGINE_NIHO_3
                    | crate::settings::ENGINE_NIHO_4
                    | crate::settings::ENGINE_NIHO_5
                    | crate::settings::ENGINE_NIHO_7
                    | crate::settings::ENGINE_NIHO_11
                    | crate::settings::ENGINE_NIHO_6
                    | crate::settings::ENGINE_NIHO_10
                    | crate::settings::ENGINE_NIHO_8
                    | crate::settings::ENGINE_NIHO_12
                    | crate::settings::ENGINE_NIHO_13
                    | crate::settings::ENGINE_NIHO_14
            ) && amount > 0.0;
            if niho3_positive {
                let q = (amount / 100.0).clamp(0.0, 1.0);
                a *= libm::exp(NIHO3_BLACKS_A_LINEAR * q + NIHO3_BLACKS_A_QUADRATIC * q * q);
                c *= libm::exp(0.12017610174614558 * q - 0.17675190656097162 * q * q);
            }
            let beta = if niho3_positive {
                NIHO3_BLACKS_BETA
            } else if amount > 0.0 {
                BLACKS_BETA_POSITIVE
            } else {
                BLACKS_BETA_NEGATIVE
            };
            let direct = Anchored {
                anchor: 1.0,
                m,
                a,
                c,
            };
            (
                CurveTable::new(&move |u| direct.eval(u)),
                GainTable::new(direct),
                direct,
                beta,
            )
        });
        let p = Parametric {
            shadows: settings.parametric_shadows,
            darks: settings.parametric_darks,
            lights: settings.parametric_lights,
            highlights: settings.parametric_highlights,
            shadow_split: settings.parametric_shadow_split,
            midtone_split: settings.parametric_midtone_split,
            highlight_split: settings.parametric_highlight_split,
        };
        let parametric =
            (p.shadows != 0.0 || p.darks != 0.0 || p.lights != 0.0 || p.highlights != 0.0)
                .then(|| CurveTable::new(&move |v| parametric_gray(v, &p)));
        let splines = PreparedPointCurve::new(&settings.tone_curves);
        let point = splines
            .composite
            .as_ref()
            .map(|sp| CurveTable::new(&|v| sp.evaluate(v).clamp(0.0, 1.0)));
        let channel = |sp: &Option<DngSpline>| {
            sp.as_ref()
                .map(|sp| CurveTable::new(&|v| sp.evaluate(v).clamp(0.0, 1.0)))
        };
        Self {
            exposure,
            contrast,
            dehaze: PreparedDehaze::new(settings.dehaze),
            whites,
            blacks,
            parametric,
            look: None,
            point,
            channels: [
                channel(&splines.red),
                channel(&splines.green),
                channel(&splines.blue),
            ],
        }
    }

    /// Adds the look's `point-curve` tone, after the user's point curve and
    /// RGB channel curves (the closest order to Lightroom's Adobe Color over
    /// the three bundled presets, S8 #16947). RAW only: JPEG / PNG get no
    /// look.
    pub fn with_look(mut self, look: Option<&crate::look::LookParams>) -> Self {
        self.look = look
            .filter(|p| p.tone_stage() == crate::look::ToneStage::PointCurve)
            .map(|p| CurveTable::new(&|u| p.curve(u)));
        self
    }

    pub fn apply(&self, value: Rgb) -> Rgb {
        let mut v = value;
        if let Some(t) = &self.exposure {
            v = encoded_curve_table(v, t);
        }
        if let Some(t) = &self.contrast {
            v = encoded_curve_table(v, t);
        }
        if let Some(d) = &self.dehaze {
            v = d.apply(v);
        }
        if let Some((t, gains, direct, beta, kappa)) = &self.whites {
            v = mixed_table(v, *beta, *kappa, t, gains, *direct);
        }
        if let Some((t, gains, direct, beta)) = &self.blacks {
            v = mixed_table(v, *beta, 1.0, t, gains, *direct);
        }
        if let Some(t) = &self.parametric {
            v = encoded_curve_table(v, t);
        }
        if let Some(t) = &self.point {
            v = encoded_curve_table(v, t);
        }
        for (index, table) in self.channels.iter().enumerate() {
            if let Some(t) = table {
                let encoded = srgb_encode_fast(v[index].clamp(0.0, 1.0));
                v[index] = srgb_decode_fast(t.eval(encoded));
            }
        }
        if let Some(t) = &self.look {
            v = encoded_curve_table(v, t);
        }
        v
    }
}

/// Direct (unsampled) Stage P, for tests: Contrast -> Dehaze -> Whites ->
/// Blacks -> Parametric -> Point curve.
pub fn apply_post_ops(value: Rgb, settings: &DevelopSettings) -> Rgb {
    let mut v = contrast(value, settings.contrast);
    v = dehaze(v, settings.dehaze);
    v = whites(v, settings.whites);
    v = blacks(v, settings.blacks);
    v = parametric(
        v,
        &Parametric {
            shadows: settings.parametric_shadows,
            darks: settings.parametric_darks,
            lights: settings.parametric_lights,
            highlights: settings.parametric_highlights,
            shadow_split: settings.parametric_shadow_split,
            midtone_split: settings.parametric_midtone_split,
            highlight_split: settings.parametric_highlight_split,
        },
    );
    PreparedPointCurve::new(&settings.tone_curves).apply(v)
}

/// `ToneOps.needsPostOps`.
pub fn needs_post_ops(settings: &DevelopSettings) -> bool {
    settings.contrast != 0.0
        || settings.dehaze != 0.0
        || settings.whites != 0.0
        || settings.blacks != 0.0
        || settings.parametric_shadows != 0.0
        || settings.parametric_darks != 0.0
        || settings.parametric_lights != 0.0
        || settings.parametric_highlights != 0.0
        || !curves_are_identity(&settings.tone_curves, 1e-9)
}
