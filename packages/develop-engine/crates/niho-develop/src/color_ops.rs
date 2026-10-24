//! Stage Q point operations and Camera Calibration: a port of Photo Bench
//! `ColorOps.swift` (itself a port of `color_model.py` / `hsl_model.py`).
//! Every constant is transcribed verbatim. Linear ProPhoto in and out.

use crate::color::{
    linear_srgb_to_oklab, mat_vec, mat_vec_f32, srgb_decode, srgb_encode, Mat3, IDENTITY, PP_LUMA,
    PROPHOTO_TO_SRGB, PROPHOTO_TO_SRGB_F32, SRGB_TO_PROPHOTO,
};
use crate::settings::{
    CalibrationSettings, ColorGradingSettings, ColorPoint, DevelopSettings, HslAdjustment, HslBand,
};
use crate::tone_ops::Rgb;

#[inline]
fn pow(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}

#[inline]
fn pp_luminance(x: Rgb) -> f64 {
    x[0] * PP_LUMA[0] + x[1] * PP_LUMA[1] + x[2] * PP_LUMA[2]
}

#[inline]
fn clamp01(v: Rgb) -> Rgb {
    [
        v[0].clamp(0.0, 1.0),
        v[1].clamp(0.0, 1.0),
        v[2].clamp(0.0, 1.0),
    ]
}

#[inline]
fn linear_srgb_to_oklab_f64(rgb: Rgb) -> Rgb {
    let l = 0.412_221_470_8 * rgb[0] + 0.536_332_536_3 * rgb[1] + 0.051_445_992_9 * rgb[2];
    let m = 0.211_903_498_2 * rgb[0] + 0.680_699_545_1 * rgb[1] + 0.107_396_956_6 * rgb[2];
    let s = 0.088_302_461_9 * rgb[0] + 0.281_718_837_6 * rgb[1] + 0.629_978_700_5 * rgb[2];
    let (l_, m_, s_) = (libm::cbrt(l), libm::cbrt(m), libm::cbrt(s));
    [
        0.210_454_255_3 * l_ + 0.793_617_785 * m_ - 0.004_072_046_8 * s_,
        1.977_998_495_1 * l_ - 2.428_592_205 * m_ + 0.450_593_709_9 * s_,
        0.025_904_037_1 * l_ + 0.782_771_766_2 * m_ - 0.808_675_766 * s_,
    ]
}

#[inline]
fn oklab_to_linear_srgb_f64(lab: Rgb) -> Rgb {
    let l_ = lab[0] + 0.396_337_777_4 * lab[1] + 0.215_803_757_3 * lab[2];
    let m_ = lab[0] - 0.105_561_345_8 * lab[1] - 0.063_854_172_8 * lab[2];
    let s_ = lab[0] - 0.089_484_177_5 * lab[1] - 1.291_485_548 * lab[2];
    let (l, m, s) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    [
        4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
        -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
        -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s,
    ]
}

#[inline]
fn oklab_to_oklch(lab: Rgb) -> Rgb {
    let chroma = libm::hypot(lab[1], lab[2]);
    let hue = if chroma <= 1e-12 {
        0.0
    } else {
        pymod(
            libm::atan2(lab[2], lab[1]) * 180.0 / core::f64::consts::PI,
            360.0,
        )
    };
    [lab[0], chroma, hue]
}

/// Converts an extended linear ProPhoto value to Oklch without clipping.
/// Invalid/HDR samples outside the persisted target contract are rejected by
/// [`crate::Session::sample_color`] instead of being silently clamped.
pub fn prophoto_to_oklch(value: Rgb) -> Rgb {
    oklab_to_oklch(linear_srgb_to_oklab_f64(mat_vec(&PROPHOTO_TO_SRGB, value)))
}

/// Compact coordinates kept by the session's active-point plane. The f64
/// conversion above remains the reference. Cache generation uses the
/// existing signed f32 OKLab kernel (including its bounded cube-root table),
/// and one output-sized plane stays bounded on wasm.
pub(crate) fn cached_prophoto_to_oklch(value: [f32; 3]) -> [f32; 3] {
    let lab = linear_srgb_to_oklab(mat_vec_f32(&PROPHOTO_TO_SRGB_F32, value));
    let chroma = libm::sqrtf(lab[1] * lab[1] + lab[2] * lab[2]);
    // Hue becomes numerically sensitive near gray; pay for the f64
    // reference once when constructing the plane, never on warm drags.
    if chroma < 0.001 {
        let mut lch = prophoto_to_oklch(value.map(f64::from)).map(|v| v as f32);
        if lch[2] >= 360.0 {
            lch[2] = 0.0;
        }
        return lch;
    }
    let hue = if chroma <= 1e-12 {
        0.0
    } else {
        (libm::atan2f(lab[2], lab[1]) * 180.0 / core::f32::consts::PI).rem_euclid(360.0)
    };
    [lab[0], chroma, if hue >= 360.0 { 0.0 } else { hue }]
}

#[inline]
fn oklch_to_oklab(lch: Rgb) -> Rgb {
    let hue = lch[2] * core::f64::consts::PI / 180.0;
    [lch[0], lch[1] * libm::cos(hue), lch[1] * libm::sin(hue)]
}

/// Keep the output lightness and chroma while restoring the OKLab hue of the
/// same color with only the authored HSL hue / luminance changes. Extended
/// gamut values deliberately remain unclipped. Close to neutral gray the hue
/// is undefined, so the rotation fades continuously to zero.
fn restore_saturation_hue(output: Rgb, reference: Rgb) -> Rgb {
    if !output.iter().chain(reference.iter()).all(|v| v.is_finite()) {
        return output;
    }
    let output_lab = linear_srgb_to_oklab_f64(mat_vec(&PROPHOTO_TO_SRGB, output));
    let reference_lab = linear_srgb_to_oklab_f64(mat_vec(&PROPHOTO_TO_SRGB, reference));
    if !output_lab
        .iter()
        .chain(reference_lab.iter())
        .all(|v| v.is_finite())
    {
        return output;
    }
    let output_chroma = libm::hypot(output_lab[1], output_lab[2]);
    let reference_chroma = libm::hypot(reference_lab[1], reference_lab[2]);
    let usable_chroma = output_chroma.min(reference_chroma);
    if usable_chroma <= 1e-12 {
        return output;
    }
    // A very narrow neutral-only transition avoids leaving partially
    // corrected, visibly chromatic colors. At C >= 0.002 the intended hue is
    // restored exactly; below it the residual is visually undefined.
    let weight = smoothstep(usable_chroma / 0.002);
    let output_hue = libm::atan2(output_lab[2], output_lab[1]);
    let reference_hue = libm::atan2(reference_lab[2], reference_lab[1]);
    let delta = wrap180((reference_hue - output_hue) * 180.0 / core::f64::consts::PI)
        * core::f64::consts::PI
        / 180.0;
    let hue = output_hue + weight * delta;
    let corrected_lab = [
        output_lab[0],
        output_chroma * libm::cos(hue),
        output_chroma * libm::sin(hue),
    ];
    let corrected = mat_vec(&SRGB_TO_PROPHOTO, oklab_to_linear_srgb_f64(corrected_lab));
    if corrected.iter().all(|v| v.is_finite()) {
        corrected
    } else {
        output
    }
}

/// Python's `%` for a positive modulus.
#[inline]
fn pymod(x: f64, m: f64) -> f64 {
    let r = libm::fmod(x, m);
    if r < 0.0 {
        r + m
    } else {
        r
    }
}

fn hue_degrees_atan2(x: Rgb) -> f64 {
    let alpha = x[0] - 0.5 * (x[1] + x[2]);
    let beta = (libm::sqrt(3.0) / 2.0) * (x[1] - x[2]);
    pymod(
        libm::atan2(beta, alpha) * 180.0 / core::f64::consts::PI,
        360.0,
    )
}

fn hsl_relative_saturation(x: Rgb) -> f64 {
    let mx = x[0].max(x[1].max(x[2]));
    let mn = x[0].min(x[1].min(x[2]));
    let chroma = mx - mn;
    let lmm = (mx + mn) / 2.0;
    chroma / (1.0 - (2.0 * lmm - 1.0).abs()).max(1e-6)
}

/// `color_model.apply_saturation`.
pub fn saturation(value: Rgb, amount: f64) -> Rgb {
    if amount == 0.0 {
        return value;
    }
    let k = 1.0 + amount / 100.0;
    let l = pp_luminance(value);
    clamp01([
        l + k * (value[0] - l),
        l + k * (value[1] - l),
        l + k * (value[2] - l),
    ])
}

const VIBRANCE_P_POSITIVE: f64 = 4.0;
const VIBRANCE_SCALE_POSITIVE: f64 = 0.75;

/// `color_model.apply_vibrance`.
pub fn vibrance(value: Rgb, amount: f64) -> Rgb {
    if amount == 0.0 {
        return value;
    }
    let l = pp_luminance(value);
    let s = hsl_relative_saturation(value);
    let hue = hue_degrees_atan2(value);
    let hue_weight = 1.0 + 0.08 * libm::cos((hue - 170.0) * core::f64::consts::PI / 180.0);
    let p = if amount > 0.0 {
        VIBRANCE_P_POSITIVE
    } else {
        0.32
    };
    let scale = if amount > 0.0 {
        VIBRANCE_SCALE_POSITIVE
    } else {
        1.0
    };
    let g = pow((1.0 - s).clamp(0.0, 1.0), p);
    let k = (1.0 + (amount / 100.0) * scale * g * hue_weight).max(0.0);
    clamp01([
        l + k * (value[0] - l),
        l + k * (value[1] - l),
        l + k * (value[2] - l),
    ])
}

// MARK: - Camera Calibration

#[rustfmt::skip]
const CALIB_D_PLUS: [Mat3; 6] = [
    // redHue
    [[0.0002, 0.0007, 0.0014], [0.1659, -0.1494, 0.0013], [-0.1490, -0.0097, 0.1286]],
    // redSaturation
    [[-0.0021, -0.0070, -0.0007], [-0.1804, 0.1629, -0.0042], [-0.1750, -0.0106, 0.1528]],
    // greenHue
    [[0.1646, -0.1614, -0.0054], [-0.0020, -0.0018, -0.0005], [-0.0001, 0.1771, -0.1442]],
    // greenSaturation
    [[0.1992, -0.2227, -0.0093], [0.0031, -0.0036, 0.0008], [0.0130, -0.2070, 0.1461]],
    // blueHue
    [[-0.1652, -0.0051, 0.1725], [0.0070, 0.1217, -0.1554], [0.0029, 0.0046, -0.0021]],
    // blueSaturation
    [[0.1920, -0.0131, -0.2228], [0.0082, 0.1484, -0.2031], [-0.0011, 0.0051, -0.0018]],
];

/// `ColorOps.calibrationMatrix`: `I + Σ (value/50) D_i`, rows normalized to
/// sum 1 (white preserving). `shadowTint` has no effect (measured).
pub fn calibration_matrix(settings: &CalibrationSettings) -> Mat3 {
    let values = [
        settings.red_hue,
        settings.red_saturation,
        settings.green_hue,
        settings.green_saturation,
        settings.blue_hue,
        settings.blue_saturation,
    ];
    let mut m = IDENTITY;
    for (value, d) in values.iter().zip(CALIB_D_PLUS.iter()) {
        if *value != 0.0 {
            let w = value / 50.0;
            for i in 0..3 {
                for j in 0..3 {
                    m[i][j] += w * d[i][j];
                }
            }
        }
    }
    for row in m.iter_mut() {
        let sum = row[0] + row[1] + row[2];
        row[0] /= sum;
        row[1] /= sum;
        row[2] /= sum;
    }
    m
}

/// `clip(M @ x, 0, 1)` reference (fixtures).
pub fn calibration(value: Rgb, settings: &CalibrationSettings) -> Rgb {
    let m = calibration_matrix(settings);
    if m == IDENTITY {
        return value;
    }
    clamp01(crate::color::mat_vec(&m, value))
}

pub fn needs_calibration(settings: &CalibrationSettings) -> bool {
    settings.red_hue != 0.0
        || settings.red_saturation != 0.0
        || settings.green_hue != 0.0
        || settings.green_saturation != 0.0
        || settings.blue_hue != 0.0
        || settings.blue_saturation != 0.0
}

// MARK: - HSL

const HSL_CENTERS: [f64; 8] = [
    359.990, 29.883, 55.251, 95.283, 160.041, 229.730, 275.113, 329.638,
];

#[inline]
fn wrap180(deg: f64) -> f64 {
    pymod(deg + 180.0, 360.0) - 180.0
}

#[inline]
fn point_axis_weight(distance: f64, range: f64) -> f64 {
    if !distance.is_finite() || !range.is_finite() || range <= 0.0 || distance >= range {
        return 0.0;
    }
    smoothstep(1.0 - distance / range)
}

/// Applies all independent OKLCH selections from the same original Lab
/// value. Overlaps are normalized only when their total weight exceeds one;
/// no point observes another point's result, so authored order is irrelevant.
/// Extended-gamut ProPhoto values are not clipped here; the existing output
/// transform remains the sole gamut policy.
fn color_points_from_oklch(value: Rgb, lch: Rgb, points: &[ColorPoint]) -> Rgb {
    if points.iter().all(|point| point.delta.is_zero())
        || !value.iter().chain(lch.iter()).all(|v| v.is_finite())
    {
        return value;
    }
    let mut total = 0.0;
    let mut hue_delta = 0.0;
    let mut chroma_delta = 0.0;
    let mut lightness_delta = 0.0;
    for point in points {
        let hue_weight = if lch[1] <= 1e-6 || point.target.chroma <= 1e-6 {
            1.0
        } else {
            point_axis_weight(wrap180(lch[2] - point.target.hue).abs(), point.range.hue)
        };
        let weight = hue_weight
            * point_axis_weight((lch[1] - point.target.chroma).abs(), point.range.chroma)
            * point_axis_weight(
                (lch[0] - point.target.lightness).abs(),
                point.range.lightness,
            );
        if weight == 0.0 {
            continue;
        }
        total += weight;
        hue_delta += weight * point.delta.hue;
        chroma_delta += weight * (point.delta.chroma_scale - 1.0);
        lightness_delta += weight * point.delta.lightness;
    }
    if total == 0.0 {
        return value;
    }
    let normalize = 1.0 / total.max(1.0);
    let output_lch = [
        lch[0] + normalize * lightness_delta,
        (lch[1] * (1.0 + normalize * chroma_delta)).max(0.0),
        pymod(lch[2] + normalize * hue_delta, 360.0),
    ];
    let output = mat_vec(
        &SRGB_TO_PROPHOTO,
        oklab_to_linear_srgb_f64(oklch_to_oklab(output_lch)),
    );
    if output.iter().all(|v| v.is_finite()) {
        output
    } else {
        value
    }
}

pub fn color_points(value: Rgb, points: &[ColorPoint]) -> Rgb {
    if points.iter().all(|point| point.delta.is_zero()) || !value.iter().all(|v| v.is_finite()) {
        return value;
    }
    let lch = prophoto_to_oklch(value);
    color_points_from_oklch(value, lch, points)
}

fn hsl_band_weight(hue_deg: f64, ordinal: usize) -> f64 {
    let n = HSL_CENTERS.len();
    let center = HSL_CENTERS[ordinal];
    let d_prev = wrap180(HSL_CENTERS[(ordinal + n - 1) % n] - center);
    let d_next = wrap180(HSL_CENTERS[(ordinal + 1) % n] - center);
    let dh = wrap180(hue_deg - center);
    let half_pi = core::f64::consts::PI / 2.0;
    if dh >= d_prev && dh <= 0.0 {
        let c = libm::cos((dh / d_prev) * half_pi);
        return c * c;
    }
    if dh >= 0.0 && dh <= d_next {
        let c = libm::cos((dh / d_next) * half_pi);
        return c * c;
    }
    0.0
}

fn gap_to_next(ordinal: usize) -> f64 {
    let n = HSL_CENTERS.len();
    pymod(
        wrap180(HSL_CENTERS[(ordinal + 1) % n] - HSL_CENTERS[ordinal]),
        360.0,
    )
}

fn gap_from_prev(ordinal: usize) -> f64 {
    let n = HSL_CENTERS.len();
    pymod(
        wrap180(HSL_CENTERS[ordinal] - HSL_CENTERS[(ordinal + n - 1) % n]),
        360.0,
    )
}

const HUE_FLOOR_DEG_AT_60: f64 = 17.983;
const HUE_K_GAP_AT_60: f64 = 0.5414;

fn hue_shift_max_deg(ordinal: usize, sign: f64) -> f64 {
    let gap = if sign > 0.0 {
        gap_to_next(ordinal)
    } else {
        gap_from_prev(ordinal)
    };
    sign * HUE_FLOOR_DEG_AT_60.max(HUE_K_GAP_AT_60 * gap)
}

const HSL_SAT_A_PLUS: f64 = 0.6109;
const HSL_SAT_A_MINUS: f64 = -0.6252;
const HSL_SAT_B_MINUS: f64 = 0.2262;

fn hsl_sat_delta_unit(s_in: f64, slider: f64) -> f64 {
    let scale = slider.abs() / 60.0;
    let bell = HSL_SAT_A_PLUS * s_in * (1.0 - s_in);
    let quad = HSL_SAT_A_MINUS * s_in + HSL_SAT_B_MINUS * s_in * s_in;
    scale * if slider >= 0.0 { bell } else { quad }
}

struct LumParams {
    k_plus: f64,
    p_plus: f64,
    q_plus: f64,
    k_minus: f64,
    p_minus: f64,
    q_minus: f64,
}

#[rustfmt::skip]
const HSL_LUM_PARAMS_AT_60: [LumParams; 8] = [
    LumParams { k_plus: 0.5043, p_plus: 0.4057, q_plus: 1.3574, k_minus: -0.4577, p_minus: 0.2445, q_minus: 1.4495 },
    LumParams { k_plus: 0.4786, p_plus: 0.5539, q_plus: 1.1517, k_minus: -0.5940, p_minus: 0.4513, q_minus: 1.3820 },
    LumParams { k_plus: 0.3728, p_plus: 0.6234, q_plus: 0.7955, k_minus: -0.6795, p_minus: 0.6115, q_minus: 1.2223 },
    LumParams { k_plus: 0.3150, p_plus: 0.5862, q_plus: 0.7122, k_minus: -0.5476, p_minus: 0.5373, q_minus: 1.1360 },
    LumParams { k_plus: 0.4859, p_plus: 0.6716, q_plus: 1.0188, k_minus: -0.8015, p_minus: 0.6525, q_minus: 1.3838 },
    LumParams { k_plus: 0.5194, p_plus: 0.4228, q_plus: 1.3609, k_minus: -0.3748, p_minus: 0.0, q_minus: 1.4781 },
    LumParams { k_plus: 0.4064, p_plus: 0.2450, q_plus: 1.3563, k_minus: -0.2764, p_minus: 0.0, q_minus: 1.3945 },
    LumParams { k_plus: 0.6047, p_plus: 0.5042, q_plus: 1.4334, k_minus: -0.4994, p_minus: 0.2566, q_minus: 1.5077 },
];
const HSL_LOW_S_FADE: f64 = 0.04;

fn smoothstep(t: f64) -> f64 {
    let c = t.clamp(0.0, 1.0);
    c * c * (3.0 - 2.0 * c)
}

fn hsl_lum_delta_unit(ordinal: usize, s_in: f64, v_in: f64, slider: f64) -> f64 {
    let p = &HSL_LUM_PARAMS_AT_60[ordinal];
    let s_safe = s_in.max(1e-9);
    let v_safe = v_in.max(1e-9);
    let fade = smoothstep(s_in / HSL_LOW_S_FADE);
    // Only the branch the slider's sign selects (the reference computes
    // both and keeps one).
    let unit = if slider >= 0.0 {
        p.k_plus * pow(s_safe, p.p_plus) * pow(v_safe, p.q_plus) * fade
    } else {
        p.k_minus * pow(s_safe, p.p_minus) * pow(v_safe, p.q_minus) * fade
    };
    (slider.abs() / 60.0) * unit
}

fn rgb_to_hsv(rgb: Rgb) -> (f64, f64, f64) {
    let (r, g, b) = (rgb[0], rgb[1], rgb[2]);
    let mx = r.max(g.max(b));
    let mn = r.min(g.min(b));
    let d = mx - mn;
    let d_safe = if d == 0.0 { 1.0 } else { d };
    let rc = (mx - r) / d_safe;
    let gc = (mx - g) / d_safe;
    let bc = (mx - b) / d_safe;
    let mut h = if mx == r {
        bc - gc
    } else if mx == g {
        2.0 + rc - bc
    } else {
        4.0 + gc - rc
    };
    if d == 0.0 {
        h = 0.0;
    }
    h = pymod(h / 6.0, 1.0);
    let s = if mx > 0.0 { d / mx } else { 0.0 };
    (h * 360.0, s, mx)
}

fn hsv_to_rgb(h_deg: f64, s: f64, v: f64) -> Rgb {
    let h = pymod(h_deg, 360.0) / 60.0;
    let hf = libm::floor(h);
    let i = (hf as i64).clamp(0, 5);
    let f = h - hf;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match i {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    }
}

/// `hsl_model.apply_hsl`: 8-band mixer (single pass, HSV hue).
pub fn hsl(value: Rgb, adjustments: &[(HslBand, HslAdjustment)]) -> Rgb {
    hsl_with_luminance(value, adjustments, false)
}

fn hsl_with_luminance(
    value: Rgb,
    adjustments: &[(HslBand, HslAdjustment)],
    niho4_luminance: bool,
) -> Rgb {
    if !adjustments
        .iter()
        .any(|(_, a)| a.hue != 0.0 || a.saturation != 0.0 || a.luminance != 0.0)
    {
        return value;
    }
    let (h_in, s_in, v_in) = rgb_to_hsv(value);
    let mut hue_shift = 0.0;
    let mut sat_delta = 0.0;
    let mut lum_delta = 0.0;
    for band in HslBand::ALL {
        let Some((_, adjustment)) = adjustments.iter().find(|(b, _)| *b == band) else {
            continue;
        };
        let ordinal = band.ordinal();
        let wi = hsl_band_weight(h_in, ordinal);
        if adjustment.hue != 0.0 {
            let sign = if adjustment.hue >= 0.0 { 1.0 } else { -1.0 };
            hue_shift += wi * (adjustment.hue.abs() / 60.0) * hue_shift_max_deg(ordinal, sign);
        }
        if adjustment.saturation != 0.0 {
            sat_delta += wi * hsl_sat_delta_unit(s_in, adjustment.saturation);
        }
        if adjustment.luminance != 0.0 {
            lum_delta += wi * hsl_lum_delta_unit(ordinal, s_in, v_in, adjustment.luminance);
        }
    }
    let h_out = pymod(h_in + hue_shift, 360.0);
    let s_out = (s_in + sat_delta).clamp(0.0, 1.0);
    let mut rgb_out = if sat_delta < 0.0 {
        let rgb_hue = hsv_to_rgb(h_out, s_in, v_in);
        let mx = rgb_hue[0].max(rgb_hue[1].max(rgb_hue[2]));
        let mn = rgb_hue[0].min(rgb_hue[1].min(rgb_hue[2]));
        let l_mid = 0.5 * (mx + mn);
        let denom = (mx - mn) - s_out * (mx - l_mid);
        let k = if denom > 1e-9 {
            s_out * l_mid / denom
        } else {
            1.0
        };
        [
            l_mid + k * (rgb_hue[0] - l_mid),
            l_mid + k * (rgb_hue[1] - l_mid),
            l_mid + k * (rgb_hue[2] - l_mid),
        ]
    } else {
        hsv_to_rgb(h_out, s_out, v_in)
    };
    if niho4_luminance
        && adjustments
            .iter()
            .any(|(_, adjustment)| adjustment.luminance != 0.0)
    {
        let input = if adjustments
            .iter()
            .any(|(_, adjustment)| adjustment.hue != 0.0 || adjustment.saturation != 0.0)
        {
            rgb_out
        } else {
            value
        };
        return niho4_luminance_curve(input, h_in, s_in, v_in, adjustments);
    }
    if lum_delta != 0.0 {
        let y_mid = pp_luminance(rgb_out);
        let y_target = (y_mid + lum_delta).max(0.0);
        let scale = if y_mid > 1e-9 { y_target / y_mid } else { 1.0 };
        rgb_out = [rgb_out[0] * scale, rgb_out[1] * scale, rgb_out[2] * scale];
    }
    rgb_out
}

/// R317 frozen eight-coefficient HSL luminance response. Extended-range
/// residuals stay unbounded around the bounded core.
fn niho4_luminance_curve(
    value: Rgb,
    hue: f64,
    saturation: f64,
    val: f64,
    adjustments: &[(HslBand, HslAdjustment)],
) -> Rgb {
    const COEFF: [[f64; 4]; 2] = [
        [
            0.8642651293535236,
            0.728037484541078,
            0.6333053270902925,
            0.9538800408029594,
        ],
        [
            1.1679924540575608,
            0.7891356378871454,
            0.7483460350243064,
            1.1042904064058978,
        ],
    ];
    let mut amount = [0.0; 2];
    for (band, adjustment) in adjustments {
        let index = usize::from(adjustment.luminance < 0.0);
        amount[index] += hsl_band_weight(hue, band.ordinal())
            * pow(adjustment.luminance.abs() / 60.0, COEFF[index][3]);
    }
    let v = val.clamp(0.0, 1.0);
    let saturation = saturation.clamp(0.0, 1.0);
    let mut shift = 0.0;
    for index in 0..2 {
        let [k, p, r, _gamma] = COEFF[index];
        shift += (if index == 0 { 1.0 } else { -1.0 })
            * amount[index]
            * libm::exp(k)
            * pow(v, p)
            * pow(saturation, r);
    }
    if shift == 0.0 {
        return value;
    }
    let core = value.map(|channel| channel.clamp(0.0, 1.0));
    let low = core[0].min(core[1].min(core[2]));
    let high = core[0].max(core[1].max(core[2]));
    let curve = |x: f64| {
        if x <= 0.0 || x >= 1.0 {
            return x;
        }
        let z = (libm::log(x / (1.0 - x)) + shift).clamp(-80.0, 80.0);
        1.0 / (1.0 + libm::exp(-z))
    };
    let bottom = curve(low);
    let top = curve(high);
    std::array::from_fn(|index| {
        value[index] - core[index]
            + bottom
            + (top - bottom) * (core[index] - low) / (high - low).max(1e-12)
    })
}

// MARK: - Color Grading

#[derive(Clone, Copy)]
struct Beta {
    a: f64,
    p: f64,
    q: f64,
}

fn grade_direction(hue_deg: f64) -> Rgb {
    let h = pymod(hue_deg, 360.0) / 60.0;
    let hf = libm::floor(h);
    let i = (hf as i64).rem_euclid(6);
    let f = h - hf;
    let c = match i {
        0 => [1.0, f, 0.0],
        1 => [1.0 - f, 1.0, 0.0],
        2 => [0.0, 1.0, f],
        3 => [0.0, 1.0 - f, 1.0],
        4 => [f, 0.0, 1.0],
        _ => [1.0, 0.0, 1.0 - f],
    };
    let y = pp_luminance(c);
    let d = [c[0] - y, c[1] - y, c[2] - y];
    let n = libm::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    [d[0] / n, d[1] / n, d[2] / n]
}

fn band_shadow() -> Beta {
    Beta {
        a: libm::exp(-0.86051536),
        p: 0.88294159,
        q: 2.34615843,
    }
}
fn band_highlight() -> Beta {
    Beta {
        a: libm::exp(0.01113423),
        p: 1.76472336,
        q: 1.19134596,
    }
}
#[allow(clippy::excessive_precision)]
const BAND_MIDTONE: Beta = Beta {
    a: 1.5920141078510772,
    p: 1.9378569616662107,
    q: 3.0530269450978214,
};
#[allow(clippy::excessive_precision)]
const BAND_GLOBAL: Beta = Beta {
    a: 0.29233407752050095,
    p: 0.9920668755406261,
    q: 1.0121040736037288,
};
#[allow(clippy::excessive_precision)]
const LUM_SHADOW: Beta = Beta {
    a: 0.12947373365072104,
    p: 0.6354625632941924,
    q: 2.3947249354714275,
};
#[allow(clippy::excessive_precision)]
const LUM_HIGHLIGHT: Beta = Beta {
    a: 0.2916981518720153,
    p: 1.5394825079594296,
    q: 0.36475501165219637,
};

// Midtone / global luminance (niho-photo#39): NIHO's approximation. There
// is no Lightroom calibration for these yet (no reference export measures
// them); the calibration procedure is to be added as a new round under
// `tools/calibrate` (`make_lr_round*.py`), and these constants refitted then.
//
// The model keeps the fitted bands' form: `beta_weight(Y) * (lum / 50)`
// added to R, G and B, positive brightening.
// - Shape: the Lightroom-fitted saturation band of the same zone
//   (`BAND_MIDTONE`'s / `BAND_GLOBAL`'s `p`, `q`), so both vanish at black
//   and white (the global band is ~4Y(1-Y): it lifts the whole range but
//   keeps the black and white points, and stays monotonic at +/-100).
// - Size: at +/-100 the band moves the luminance at its peak by
//   `LUM_PEAK_RELATIVE` of that luminance, the mean of the fitted shadow
//   (+100: 0.0546 at Y 0.2097, 26.05%) and highlight (+100: 0.2301 at Y
//   0.8085, 28.47%) luminance bands' relative peak change (~ +0.35 EV).
//   Absolute peaks would differ 4x between those two bands; relative ones
//   agree within 10%. `a = LUM_PEAK_RELATIVE * y* / 2 / (y*^p (1-y*)^q)`
//   with `y* = p / (p + q)` (the `luminance_band_normalization` test
//   recomputes them).
// - Balance only moves the shadow / highlight split, so it does not scale
//   these two bands (blending does not either, like the fitted ones).
#[cfg(test)]
const LUM_PEAK_RELATIVE: f64 = 0.27256592762777143;
#[allow(clippy::excessive_precision)]
const LUM_MIDTONE: Beta = Beta {
    a: 1.4839676056718991,
    p: BAND_MIDTONE.p,
    q: BAND_MIDTONE.q,
};
#[allow(clippy::excessive_precision)]
const LUM_GLOBAL: Beta = Beta {
    a: 0.27059503718397543,
    p: BAND_GLOBAL.p,
    q: BAND_GLOBAL.q,
};

fn beta_weight(y: f64, band: Beta) -> f64 {
    let yy = y.clamp(1e-6, 1.0 - 1e-6);
    band.a * pow(yy, band.p) * pow(1.0 - yy, band.q)
}

const GRADE_PROTECT_EXPONENT: f64 = 1.0;

fn protect_exponents(blend: f64) -> (f64, f64) {
    let t = ((blend - 50.0) / 50.0).clamp(0.0, 1.0);
    (0.5 + 0.5 * t, t)
}

fn balance_scale(balance: f64) -> (f64, f64) {
    (
        (1.0 - balance / 100.0 * 0.55).max(0.0),
        (1.0 + balance / 100.0 * 0.05).max(0.0),
    )
}

const BLEND50_MASK_Y: [f64; 13] = [
    0.0, 0.015, 0.045, 0.08, 0.125, 0.185, 0.26, 0.35, 0.45, 0.56, 0.685, 0.825, 1.0,
];
const BLEND50_MASK_SHADOW: [f64; 13] = [
    0.9, 0.86, 0.74, 0.54, 0.39, 0.29, 0.26, 0.26, 0.24, 0.27, 0.30, 0.25, 0.25,
];
const BLEND50_MASK_HIGHLIGHT: [f64; 13] = [
    0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.28, 0.35, 0.45, 0.53, 0.60, 0.64, 0.70,
];

fn interpolate(x: f64, knots: &[f64], values: &[f64]) -> f64 {
    if x <= knots[0] {
        return values[0];
    }
    for k in 1..knots.len() {
        if x <= knots[k] {
            let f = (x - knots[k - 1]) / (knots[k] - knots[k - 1]);
            return values[k - 1] + (values[k] - values[k - 1]) * f;
        }
    }
    values[values.len() - 1]
}

fn blend_mask(blend: f64, shadow: bool, y: f64) -> f64 {
    if blend >= 100.0 {
        return 1.0;
    }
    let t = (100.0 - blend.clamp(0.0, 100.0)) / 50.0;
    let m50 = interpolate(
        y,
        &BLEND50_MASK_Y,
        if shadow {
            &BLEND50_MASK_SHADOW
        } else {
            &BLEND50_MASK_HIGHLIGHT
        },
    );
    (1.0 - t * (1.0 - m50)).clamp(0.0, 1.0)
}

pub fn needs_color_grading(s: &ColorGradingSettings) -> bool {
    s.shadow.saturation != 0.0
        || s.shadow.luminance != 0.0
        || s.midtone.saturation != 0.0
        || s.midtone.luminance != 0.0
        || s.highlight.saturation != 0.0
        || s.highlight.luminance != 0.0
        || s.global.saturation != 0.0
        || s.global.luminance != 0.0
}

/// `color_model.apply_color_grading`, plus NIHO's midtone / global
/// luminance (`LUM_MIDTONE` / `LUM_GLOBAL`, not calibrated against
/// Lightroom yet; at 0 the result is Photo Bench's bit for bit).
pub fn color_grading(value: Rgb, s: &ColorGradingSettings) -> Rgb {
    color_grading_with(value, s, &GradeDirections::new(s))
}

/// Per-band grading directions (fixed per settings value).
#[derive(Debug, Clone)]
pub struct GradeDirections([Rgb; 4]);

impl GradeDirections {
    pub fn new(s: &ColorGradingSettings) -> Self {
        Self([
            grade_direction(s.shadow.hue),
            grade_direction(s.highlight.hue),
            grade_direction(s.midtone.hue),
            grade_direction(s.global.hue),
        ])
    }
}

#[inline]
fn pow_protect(x: f64, exponent: f64) -> f64 {
    if exponent == 1.0 {
        x
    } else if exponent == 0.0 {
        1.0
    } else {
        pow(x, exponent)
    }
}

fn color_grading_with(value: Rgb, s: &ColorGradingSettings, directions: &GradeDirections) -> Rgb {
    if !needs_color_grading(s) {
        return value;
    }
    let y_luma = pp_luminance(value).clamp(0.0, 1.0);
    let (shadow_scale, highlight_scale) = balance_scale(s.balance);
    let unprotected = (1.0 - hsl_relative_saturation(value)).clamp(0.0, 1.0);
    let (exp_shadow, exp_highlight) = protect_exponents(s.blending);
    let mut delta = [0.0; 3];
    let bands: [(Beta, f64, f64, f64, f64, Option<bool>); 4] = [
        (
            band_shadow(),
            s.shadow.hue,
            s.shadow.saturation,
            shadow_scale,
            exp_shadow,
            Some(true),
        ),
        (
            band_highlight(),
            s.highlight.hue,
            s.highlight.saturation,
            highlight_scale,
            exp_highlight,
            Some(false),
        ),
        (
            BAND_MIDTONE,
            s.midtone.hue,
            s.midtone.saturation,
            1.0,
            GRADE_PROTECT_EXPONENT,
            None,
        ),
        (
            BAND_GLOBAL,
            s.global.hue,
            s.global.saturation,
            1.0,
            GRADE_PROTECT_EXPONENT,
            None,
        ),
    ];
    for (index, (band, _hue, sat, extra, exponent, mask)) in bands.into_iter().enumerate() {
        if sat == 0.0 {
            continue;
        }
        let mut w =
            beta_weight(y_luma, band) * (sat / 30.0) * extra * pow_protect(unprotected, exponent);
        if let Some(shadow) = mask {
            w *= blend_mask(s.blending, shadow, y_luma);
        }
        let dir = directions.0[index];
        delta[0] += w * dir[0];
        delta[1] += w * dir[1];
        delta[2] += w * dir[2];
    }
    // Midtone / global come last and skip at 0, so a photo without them
    // renders exactly as before.
    let lum_bands = [
        (LUM_SHADOW, -1.0, s.shadow.luminance, shadow_scale),
        (LUM_HIGHLIGHT, 1.0, s.highlight.luminance, highlight_scale),
        (LUM_MIDTONE, 1.0, s.midtone.luminance, 1.0),
        (LUM_GLOBAL, 1.0, s.global.luminance, 1.0),
    ];
    for (band, sign, lum, scale) in lum_bands {
        if lum == 0.0 {
            continue;
        }
        let w = beta_weight(y_luma, band) * sign * (lum / 50.0) * scale;
        delta[0] += w;
        delta[1] += w;
        delta[2] += w;
    }
    clamp01([
        value[0] + delta[0],
        value[1] + delta[1],
        value[2] + delta[2],
    ])
}

// MARK: - Black & white (NIHO extension, #17120 E1; not in Photo Bench)

/// Strength of a black & white mix slider at +100 per band
/// ([`HslBand::ordinal`]: red, orange, yellow, green, aqua, blue, purple,
/// magenta): the square root of the gray of a fully saturated color of the
/// band grows by this factor's excess over 1. Fitted to Lightroom's round8
/// and round9 exports (E1c #17259: `bw_warm` / `bw_cool` and all bands at
/// +100 / -100, 6 scenes; neighbors share a value where a band has few
/// pixels).
pub const GRAY_MIX_BRIGHTEN: [f64; 8] = [0.90, 0.90, 0.90, 0.85, 0.85, 1.30, 1.00, 1.00];
/// The same at -100: Lightroom darkens a band more than it brightens it,
/// down to black where `strength * saturation` reaches 1 (round9: a blue sky
/// at -100 is black).
pub const GRAY_MIX_DARKEN: [f64; 8] = [1.45, 1.45, 1.45, 1.55, 1.55, 1.75, 1.15, 1.15];
/// A slider between acts by `(|mix| / 100)^shape` of its strength (round8:
/// -40 darkens less than 0.4 of -100).
pub const GRAY_MIX_BRIGHTEN_SHAPE: f64 = 1.0;
pub const GRAY_MIX_DARKEN_SHAPE: f64 = 1.35;

/// Black & white mix: the gray of the color scaled by
/// `g = max(1 + f * s, 0)^2` before the tone curve, with
/// `f = sum_b hsl_band_weight(h, b) * k_b` (`k_b` the band's strength for
/// its slider, [`GRAY_MIX_BRIGHTEN`] / `-`[`GRAY_MIX_DARKEN`], times
/// `(|mix_b| / 100)^shape`) and `s` the HSV saturation (linear ProPhoto; the
/// mix vanishes at neutral gray). Lightroom mixes before its tone curve
/// (round9: the same saturation is darkened alike in shadows and
/// midtones, and a bright sky the curve has desaturated still turns black),
/// so with `toned` (a RAW working copy: `value` is past the ACR3 default
/// curve, which keeps the hue and maps the largest and the smallest channel)
/// `s` is measured on the channels taken back through the curve, and the
/// gray is the luminance of the scaled color put through the curve again
/// (`lo' + (hi' - lo') * (Y - lo) / (hi - lo)`, `hi' = curve(g * hi)`).
/// Without (JPEG / PNG: no default curve) the gray is `g * Y`. `Y` is the
/// ProPhoto luminance; `mix` is indexed by [`HslBand::ordinal`].
pub fn gray_mix(value: Rgb, mix: &[f64; 8], toned: bool) -> Rgb {
    let y = pp_luminance(value);
    let mut gray = y;
    let hi = value[0].max(value[1]).max(value[2]);
    let lo = value[0].min(value[1]).min(value[2]);
    if hi > lo && mix.iter().any(|m| *m != 0.0) {
        let (top, bottom) = if toned {
            (crate::acr3::inverse(hi), crate::acr3::inverse(lo))
        } else {
            (hi, lo)
        };
        let (h, _, _) = rgb_to_hsv(value);
        let mut f = 0.0;
        for (ordinal, m) in mix.iter().enumerate() {
            if *m != 0.0 {
                let amount = (m.abs() / 100.0).min(1.0);
                let strength = if *m > 0.0 {
                    GRAY_MIX_BRIGHTEN[ordinal] * libm::pow(amount, GRAY_MIX_BRIGHTEN_SHAPE)
                } else {
                    -GRAY_MIX_DARKEN[ordinal] * libm::pow(amount, GRAY_MIX_DARKEN_SHAPE)
                };
                f += hsl_band_weight(h, ordinal) * strength;
            }
        }
        if f != 0.0 && top > 0.0 {
            let root = (1.0 + f * (top - bottom) / top).max(0.0);
            let gain = root * root;
            let tone = |v: f64| {
                if toned {
                    crate::acr3::evaluate(v * gain)
                } else {
                    v * gain
                }
            };
            let (hi_out, lo_out) = (tone(top), tone(bottom));
            gray = lo_out + (hi_out - lo_out) * (y - lo) / (hi - lo);
        }
    }
    let g = gray.clamp(0.0, 1.0);
    [g, g, g]
}

/// Stage Q snapshot: Vibrance -> Saturation -> HSL -> Color Grading, or in
/// black & white the mix -> Color Grading (Lightroom also replaces the
/// color mixer by the B&W mix and grades the gray; the color values are
/// kept in the settings).
#[derive(Debug, Clone)]
pub struct PreparedColorOps {
    vibrance: f64,
    saturation: f64,
    hsl: Vec<(HslBand, HslAdjustment)>,
    hsl_without_saturation: Vec<(HslBand, HslAdjustment)>,
    color_points: Vec<ColorPoint>,
    /// `Some` in black & white.
    gray_mix: Option<[f64; 8]>,
    /// The values are past the ACR3 default curve (a RAW working copy).
    toned: bool,
    grading: ColorGradingSettings,
    directions: GradeDirections,
    frozen_profile: bool,
    niho4_luminance: bool,
    /// `niho-6` on a JPEG / PNG (#18397): Vibrance is the frozen RAW response
    /// ([`crate::niho3::vibrance`]) without the RAW profile before it.
    raster_niho6: bool,
    /// `niho-10` / `niho-11`: remove only saturation-induced OKLab hue drift.
    hue_stable_saturation: bool,
}

impl PreparedColorOps {
    /// Stage Q of a JPEG / PNG (no default tone curve before it).
    pub fn new(settings: &DevelopSettings) -> Self {
        Self::with_curve(settings, false)
    }

    /// Stage Q of a RAW working copy: its input is past the ACR3 default
    /// curve (the black & white mix acts before it, [`gray_mix`]).
    pub fn after_default_curve(settings: &DevelopSettings) -> Self {
        Self::with_curve(settings, true)
    }

    fn with_curve(settings: &DevelopSettings, toned: bool) -> Self {
        Self {
            toned,
            vibrance: settings.vibrance,
            saturation: settings.saturation,
            hsl: settings.hsl.entries().to_vec(),
            hsl_without_saturation: settings
                .hsl
                .entries()
                .iter()
                .map(|(band, adjustment)| {
                    (
                        *band,
                        HslAdjustment {
                            saturation: 0.0,
                            ..*adjustment
                        },
                    )
                })
                .collect(),
            color_points: settings.color_points.clone(),
            gray_mix: settings.grayscale.then_some(settings.gray_mixer.bands),
            grading: settings.color_grading.clone(),
            directions: GradeDirections::new(&settings.color_grading),
            frozen_profile: toned
                && matches!(
                    settings.engine.as_str(),
                    crate::settings::ENGINE_NIHO_3
                        | crate::settings::ENGINE_NIHO_4
                        | crate::settings::ENGINE_NIHO_5
                        | crate::settings::ENGINE_NIHO_7
                        | crate::settings::ENGINE_NIHO_11
                ),
            // #18397: `niho-6` JPEG / PNG takes the NIHO 4 HSL luminance too
            // (Lightroom's HSL luminance on a JPEG matches the RAW one, not
            // the Photo Bench port: R14 in `NIHO6.md`).
            niho4_luminance: matches!(
                (toned, settings.engine.as_str()),
                (
                    true,
                    crate::settings::ENGINE_NIHO_4
                        | crate::settings::ENGINE_NIHO_5
                        | crate::settings::ENGINE_NIHO_7
                        | crate::settings::ENGINE_NIHO_11
                ) | (
                    false,
                    crate::settings::ENGINE_NIHO_6
                        | crate::settings::ENGINE_NIHO_8
                        | crate::settings::ENGINE_NIHO_10
                        | crate::settings::ENGINE_NIHO_12
                        | crate::settings::ENGINE_NIHO_13
                        | crate::settings::ENGINE_NIHO_14
                )
            ),
            raster_niho6: !toned
                && matches!(
                    settings.engine.as_str(),
                    crate::settings::ENGINE_NIHO_6
                        | crate::settings::ENGINE_NIHO_8
                        | crate::settings::ENGINE_NIHO_10
                        | crate::settings::ENGINE_NIHO_12
                        | crate::settings::ENGINE_NIHO_13
                        | crate::settings::ENGINE_NIHO_14
                ),
            // `niho-12`〜`niho-14` are the `niho-10` formula on raster input
            // only; their legacy RAW path is the `niho-2` formula (no hue
            // restoration).
            hue_stable_saturation: matches!(
                (toned, settings.engine.as_str()),
                (
                    _,
                    crate::settings::ENGINE_NIHO_10 | crate::settings::ENGINE_NIHO_11
                ) | (
                    false,
                    crate::settings::ENGINE_NIHO_12
                        | crate::settings::ENGINE_NIHO_13
                        | crate::settings::ENGINE_NIHO_14
                )
            ),
        }
    }

    /// Stage Q immediately before independent color points and Color
    /// Grading. The picker uses this exact operation so existing points,
    /// grading, and the output transform cannot move the selected target.
    pub fn apply_before_color_points(&self, value: Rgb) -> Rgb {
        if let Some(mix) = &self.gray_mix {
            return gray_mix(value, mix, self.toned);
        }
        let mut v = if self.frozen_profile {
            // R236: evaluate the existing R218 9^3 encoded-sRGB LUT on the
            // clipped in-gamut projection, then add only its decoded linear
            // residual to the original wide-gamut/headroom value.  The RAW
            // profile precedes Vibrance / Saturation / HSL and is active for
            // a neutral color edit too.  The B&W branch above is unchanged.
            let rgb = mat_vec(&PROPHOTO_TO_SRGB, value);
            let clipped = rgb.map(|channel| channel.clamp(0.0, 1.0));
            let transformed =
                crate::niho3::profile_lut(clipped.map(|channel| srgb_encode(channel) as f32));
            let corrected = std::array::from_fn(|channel| {
                rgb[channel] + srgb_decode(f64::from(transformed[channel])) - clipped[channel]
            });
            crate::niho3::vibrance(mat_vec(&SRGB_TO_PROPHOTO, corrected), self.vibrance)
        } else if self.raster_niho6 {
            crate::niho3::vibrance(value, self.vibrance)
        } else {
            vibrance(value, self.vibrance)
        };
        let saturation_is_active = self.saturation != 0.0
            || self
                .hsl
                .iter()
                .any(|(_, adjustment)| adjustment.saturation != 0.0);
        let reference = (self.hue_stable_saturation && saturation_is_active)
            .then(|| hsl_with_luminance(v, &self.hsl_without_saturation, self.niho4_luminance));
        v = saturation(v, self.saturation);
        v = hsl_with_luminance(v, &self.hsl, self.niho4_luminance);
        if let Some(reference) = reference {
            v = restore_saturation_hue(v, reference);
        }
        v
    }

    pub fn apply(&self, value: Rgb) -> Rgb {
        self.apply_color_points_and_grading(self.apply_before_color_points(value))
    }

    /// The exact, per-pixel end of Stage Q. Keeping this out of the cube is
    /// required for the smallest color-point ranges: a 64^3 grid can have no
    /// node inside a one-degree / 0.001-wide selection.
    pub(crate) fn apply_color_points_and_grading(&self, value: Rgb) -> Rgb {
        // The independent mixer is last in the color mixer, after
        // niho-10/11's hue stabilization and before Color Grading.
        let value = if self.gray_mix.is_some() {
            value
        } else {
            color_points(value, &self.color_points)
        };
        color_grading_with(value, &self.grading, &self.directions)
    }

    /// Active-point tail using the session plane's coordinates. The f64
    /// implementation above remains the independent reference; the cached
    /// coordinates eliminate cbrt/atan2 work while dragging without moving
    /// the point operation into a cube.
    pub(crate) fn apply_cached_color_points_and_grading(
        &self,
        value: [f32; 3],
        lch: [f32; 3],
    ) -> [f32; 3] {
        let value = value.map(f64::from);
        let value = if self.gray_mix.is_some() {
            value
        } else {
            color_points_from_oklch(value, lch.map(f64::from), &self.color_points)
        };
        color_grading_with(value, &self.grading, &self.directions).map(|channel| channel as f32)
    }

    /// RAW-only split of the black & white operation. The mix is measured
    /// just after ACR3, before cube P and calibration; the remaining color
    /// operation is applied after those stages.
    pub(crate) fn apply_raw_before_post(&self, value: Rgb) -> Rgb {
        match &self.gray_mix {
            Some(mix) => gray_mix(value, mix, self.toned),
            None => value,
        }
    }

    /// RAW-only Stage Q operation after the black & white mix has already
    /// run. For color images this is the complete Stage Q operation.
    pub(crate) fn apply_raw_after_pre_post(&self, value: Rgb) -> Rgb {
        if self.gray_mix.is_some() {
            color_grading_with(value, &self.grading, &self.directions)
        } else {
            self.apply(value)
        }
    }

    /// RAW Stage Q through the point-selection input, after the B&W split.
    pub(crate) fn apply_raw_before_color_points_after_pre_post(&self, value: Rgb) -> Rgb {
        if self.gray_mix.is_some() {
            value
        } else {
            self.apply_before_color_points(value)
        }
    }
}

pub fn needs_color_ops(settings: &DevelopSettings) -> bool {
    (matches!(
        settings.engine.as_str(),
        crate::settings::ENGINE_NIHO_3
            | crate::settings::ENGINE_NIHO_4
            | crate::settings::ENGINE_NIHO_5
            | crate::settings::ENGINE_NIHO_7
            | crate::settings::ENGINE_NIHO_11
    ) && !settings.grayscale)
        || settings.grayscale
        || settings.vibrance != 0.0
        || settings.saturation != 0.0
        || settings
            .hsl
            .entries()
            .iter()
            .any(|(_, a)| a.hue != 0.0 || a.saturation != 0.0 || a.luminance != 0.0)
        || settings.has_active_color_points()
        || needs_color_grading(&settings.color_grading)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{OklchDelta, OklchRange, OklchTarget};
    use crate::tone_ops::rgb_tone;

    const ORANGE: usize = 1;
    const BLUE: usize = 5;

    fn mix_of(band: usize, value: f64) -> [f64; 8] {
        let mut mix = [0.0; 8];
        mix[band] = value;
        mix
    }

    #[test]
    fn gray_mix_at_zero_is_the_luminance() {
        let v = [0.42, 0.31, 0.18];
        for toned in [false, true] {
            let g = gray_mix(v, &[0.0; 8], toned);
            assert!((g[0] - pp_luminance(v)).abs() < 1e-12);
            assert!(g[0] == g[1] && g[1] == g[2]);
            // Gray has no band to mix.
            let gray = gray_mix([0.3; 3], &[-100.0; 8], toned);
            assert!((gray[0] - 0.3).abs() < 1e-12);
        }
    }

    #[test]
    fn gray_mix_scales_the_gray_by_the_square_of_one_plus_strength_times_saturation() {
        // Without a tone curve (JPEG / PNG): gray = Y * (1 + f * s)^2.
        let v = [0.40, 0.25, 0.10]; // orange (hue 30), saturation 0.75
        let (h, s, _) = rgb_to_hsv(v);
        let w = hsl_band_weight(h, ORANGE);
        assert!(w > 0.99, "{h} {w}");
        let y = pp_luminance(v);
        let up = gray_mix(v, &mix_of(ORANGE, 100.0), false)[0];
        let expected = y * (1.0 + GRAY_MIX_BRIGHTEN[ORANGE] * w * s).powi(2);
        assert!((up - expected.min(1.0)).abs() < 1e-9, "{up} {expected}");
        let down = gray_mix(v, &mix_of(ORANGE, -40.0), false)[0];
        let k = GRAY_MIX_DARKEN[ORANGE] * libm::pow(0.4, GRAY_MIX_DARKEN_SHAPE);
        let expected = y * (1.0 - k * w * s).powi(2);
        assert!((down - expected).abs() < 1e-9, "{down} {expected}");
        // -100 on a saturated color reaches black; another band's slider
        // does nothing.
        assert_eq!(gray_mix(v, &mix_of(ORANGE, -100.0), false)[0], 0.0);
        assert!((gray_mix(v, &mix_of(BLUE, -100.0), false)[0] - y).abs() < 1e-12);
    }

    #[test]
    fn gray_mix_of_a_toned_value_acts_before_the_default_curve() {
        // A RAW working copy: the value is past the ACR3 default curve. The
        // mix is the gain g on the color before the curve, so the result is
        // the luminance of curve(g * color).
        let before = [0.30, 0.34, 0.52]; // a sky blue
        let toned = rgb_tone(before, &crate::acr3::evaluate);
        let (h, s, _) = rgb_to_hsv(before);
        let mix = mix_of(BLUE, -50.0);
        let f = -GRAY_MIX_DARKEN[BLUE]
            * libm::pow(0.5, GRAY_MIX_DARKEN_SHAPE)
            * hsl_band_weight(h, BLUE);
        let g = (1.0 + f * s).powi(2);
        let expected = pp_luminance(rgb_tone(
            [before[0] * g, before[1] * g, before[2] * g],
            &crate::acr3::evaluate,
        ));
        let got = gray_mix(toned, &mix, true)[0];
        assert!((got - expected).abs() < 1e-6, "{got} {expected}");
        // The curve has desaturated the bright sky: measured past it, the
        // same slider would darken it less.
        let naive = gray_mix(toned, &mix, false)[0];
        assert!(got < naive - 0.05, "{got} {naive}");
    }

    #[test]
    fn cached_oklch_and_point_tail_track_the_f64_reference() {
        let fixtures = [
            [0.72_f32, 0.31, 0.12],
            [0.300_001, 0.3, 0.299_999],
            [-0.08, 0.45, 1.1],
            [0.02, -0.01, 0.04],
        ];
        for value in fixtures {
            let reference = prophoto_to_oklch(value.map(f64::from));
            let cached = cached_prophoto_to_oklch(value).map(f64::from);
            assert!((cached[0] - reference[0]).abs() <= 2e-6, "{value:?}");
            assert!((cached[1] - reference[1]).abs() <= 2e-6, "{value:?}");
            let hue_error = ((cached[2] - reference[2] + 180.0).rem_euclid(360.0) - 180.0).abs();
            assert!(
                reference[1] <= 1e-6 || hue_error <= 2e-3,
                "{value:?}: {cached:?} {reference:?}"
            );
            assert!((0.0..360.0).contains(&cached[2]), "{cached:?}");
        }

        let target = prophoto_to_oklch(fixtures[0].map(f64::from));
        let mut settings = DevelopSettings::neutral();
        settings.color_points = vec![
            ColorPoint {
                id: "a".into(),
                target: OklchTarget {
                    lightness: target[0],
                    chroma: target[1],
                    hue: target[2],
                },
                range: OklchRange {
                    hue: 25.0,
                    chroma: 0.08,
                    lightness: 0.15,
                },
                delta: OklchDelta {
                    hue: 14.0,
                    chroma_scale: 1.25,
                    lightness: 0.03,
                },
            },
            ColorPoint {
                id: "b".into(),
                target: OklchTarget {
                    lightness: target[0],
                    chroma: target[1],
                    hue: target[2],
                },
                range: OklchRange {
                    hue: 40.0,
                    chroma: 0.12,
                    lightness: 0.2,
                },
                delta: OklchDelta {
                    hue: -6.0,
                    chroma_scale: 0.9,
                    lightness: -0.01,
                },
            },
        ];
        let prepared = PreparedColorOps::new(&settings);
        for value in fixtures {
            let value64 = value.map(f64::from);
            let reference = prepared
                .apply_color_points_and_grading(value64)
                .map(|channel| channel as f32);
            let cached = prepared
                .apply_cached_color_points_and_grading(value, cached_prophoto_to_oklch(value));
            for channel in 0..3 {
                assert!(
                    (cached[channel] - reference[channel]).abs() <= 3e-5,
                    "{value:?}: {cached:?} {reference:?}"
                );
            }
        }
    }

    #[test]
    fn cached_points_keep_negative_and_highlight_headroom_for_output() {
        use crate::settings::{ColorPoint, OklchDelta, OklchRange, OklchTarget};
        let value = [0.7_f32, 0.1, 0.05];
        let target = prophoto_to_oklch(value.map(f64::from));
        for delta in [
            OklchDelta {
                hue: 180.0,
                chroma_scale: 3.0,
                lightness: 0.0,
            },
            OklchDelta {
                hue: 0.0,
                chroma_scale: 1.0,
                lightness: 0.6,
            },
        ] {
            let mut settings = DevelopSettings::neutral();
            settings.color_points = vec![ColorPoint {
                id: "wide".into(),
                target: OklchTarget {
                    lightness: target[0],
                    chroma: target[1],
                    hue: target[2],
                },
                range: OklchRange {
                    hue: 180.0,
                    chroma: 5.0,
                    lightness: 1.0,
                },
                delta,
            }];
            let prepared = PreparedColorOps::new(&settings);
            let reference = prepared.apply_color_points_and_grading(value.map(f64::from));
            assert!(
                reference.iter().any(|value| *value < 0.0 || *value > 1.0),
                "{reference:?}"
            );
            let cached = prepared
                .apply_cached_color_points_and_grading(value, cached_prophoto_to_oklch(value));
            for channel in 0..3 {
                assert!(
                    (f64::from(cached[channel]) - reference[channel]).abs() < 3e-5,
                    "cached={cached:?}, reference={reference:?}"
                );
            }
        }
    }

    /// The peak luminance and peak weight of a band.
    fn band_peak(band: Beta) -> (f64, f64) {
        let y = band.p / (band.p + band.q);
        (y, beta_weight(y, band))
    }

    #[test]
    fn luminance_band_normalization() {
        // The fitted shadow / highlight luminance bands move their peak by
        // ~26% / ~28.5% of its luminance at 100 (`lum / 50` = 2).
        let relative = |band: Beta| {
            let (y, w) = band_peak(band);
            2.0 * w / y
        };
        let shadow = relative(LUM_SHADOW);
        let highlight = relative(LUM_HIGHLIGHT);
        assert!((shadow - 0.2605).abs() < 1e-3, "{shadow}");
        assert!((highlight - 0.2847).abs() < 1e-3, "{highlight}");
        let mean = (shadow + highlight) / 2.0;
        assert!((LUM_PEAK_RELATIVE - mean).abs() < 1e-15, "{mean}");
        // Midtone / global: the same relative peak change, on the shape of
        // the zone's fitted saturation band.
        for (name, lum, shape) in [
            ("midtone", LUM_MIDTONE, BAND_MIDTONE),
            ("global", LUM_GLOBAL, BAND_GLOBAL),
        ] {
            assert_eq!((lum.p, lum.q), (shape.p, shape.q), "{name}");
            let (y, w) = band_peak(lum);
            let a = LUM_PEAK_RELATIVE * y / 2.0 / (pow(y, lum.p) * pow(1.0 - y, lum.q));
            assert!((lum.a - a).abs() < 1e-12 * a, "{name}: {} vs {a}", lum.a);
            assert!((2.0 * w / y - LUM_PEAK_RELATIVE).abs() < 1e-12, "{name}");
        }
    }

    #[test]
    fn midtone_and_global_luminance_tone_response() {
        let gray = |y: f64, grading: &ColorGradingSettings| color_grading([y; 3], grading)[0];
        let with = |midtone: f64, global: f64| {
            let mut g = ColorGradingSettings::default();
            g.midtone.luminance = midtone;
            g.global.luminance = global;
            g
        };
        for (midtone, global) in [(100.0, 0.0), (-100.0, 0.0), (0.0, 100.0), (0.0, -100.0)] {
            let g = with(midtone, global);
            assert!(needs_color_grading(&g));
            // Black and white stay; the tone response stays monotonic.
            assert!(gray(0.0, &g) < 1e-5 && gray(1.0, &g) > 1.0 - 1e-5);
            let mut previous = gray(0.0, &g);
            for i in 1..=1000 {
                let next = gray(i as f64 / 1000.0, &g);
                assert!(next >= previous, "{midtone} {global} at {i}");
                previous = next;
            }
        }
        assert!(!needs_color_grading(&with(0.0, 0.0)));
    }
}
