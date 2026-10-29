//! Purple / green fringes ("フリンジ軽減"): pixels near a strong luminance
//! edge whose hue is in a fringe's range are pulled toward the neutral of
//! their own luminance. Large purple or green areas away from edges
//! (flowers, leaves) are left alone.
//!
//! On the resampled window (linear light, the source's space), before the
//! local pass and every color adjustment:
//!
//! 1. Lightness `L = sqrt(Y)` (`Y` the Rec. 709 luminance of linear sRGB;
//!    a working copy's ProPhoto is converted for this only).
//! 2. Edge strength: the central-difference gradient of `L`, through
//!    `smoothstep(0.03, 0.09)` per pixel.
//! 3. Near an edge: its largest value within `radius` pixels (a square,
//!    [`defringe_radius`]: about 1 px per 512 px of the frame's long edge at
//!    this scale, at least 1, and inside the window's margin: the same
//!    reach on the photo at every size, #133).
//! 4. Hue on the hexagon of linear sRGB (`atan2(sqrt(3)/2 (G - B), R - (G +
//!    B)/2)`: red 0°, yellow 60°, green 120°, blue 240°, magenta 300°). A
//!    band's range ([`super::PURPLE_HUE`], [`super::GREEN_HUE`]) counts 1
//!    inside and fades over 10° outside. Pixels with a chroma below 3% of
//!    their luminance are neutral already (faded in up to 8%).
//! 5. `w = min(1, amount_purple / 100 * in_purple + amount_green / 100 *
//!    in_green) * near_edge * chromatic`, and `rgb + w (Y - rgb)` with `Y`
//!    the pixel's luminance in its own space.
//!
//! Fixed-order `f32` arithmetic (`libm::atan2f`): the same in wasm.

use super::{LensRender, LensSpace, GREEN_HUE, PURPLE_HUE};
use crate::color::{mat_vec_f32, PP_LUMA_F32, PROPHOTO_TO_SRGB_F32, REC709_LUMA_F32};

const EDGE_LO: f32 = 0.03;
const EDGE_HI: f32 = 0.09;
const HUE_FEATHER: f32 = 10.0;
const CHROMA_LO: f32 = 0.03;
const CHROMA_HI: f32 = 0.08;

fn smoothstep(lo: f32, hi: f32, x: f32) -> f32 {
    let t = ((x - lo) / (hi - lo)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The fringe radius on a frame whose long edge is `long_edge` at this
/// scale, inside a window margin of `pad` pixels. It grows with the size
/// without a bound (a full-size export reaches as far on the photo as its
/// screen at 2560 px, #133); up to a long edge of 3327 px it is the bounded
/// radius of before (1..6).
pub(crate) fn defringe_radius(long_edge: usize, pad: usize) -> usize {
    let r = ((long_edge + 256) / 512).max(1);
    r.min(pad.saturating_sub(2)).max(1)
}

/// The largest value of `v` (`width x height`) within `radius` pixels (a
/// square), separably.
fn dilate(v: &[f32], width: usize, height: usize, radius: usize) -> Vec<f32> {
    let mut across = vec![0.0f32; v.len()];
    for y in 0..height {
        let row = &v[y * width..(y + 1) * width];
        for x in 0..width {
            let lo = x.saturating_sub(radius);
            let hi = (x + radius).min(width - 1);
            across[y * width + x] = row[lo..=hi].iter().fold(0.0f32, |m, &e| m.max(e));
        }
    }
    let mut out = vec![0.0f32; v.len()];
    for y in 0..height {
        let lo = y.saturating_sub(radius);
        let hi = (y + radius).min(height - 1);
        for x in 0..width {
            let mut m = 0.0f32;
            for yy in lo..=hi {
                m = m.max(across[yy * width + x]);
            }
            out[y * width + x] = m;
        }
    }
    out
}

/// A band's hue range in degrees (Lightroom's `0..100` slider on the hue
/// circle).
fn degrees(scale: (f64, f64), lo: f64, hi: f64) -> (f32, f32) {
    (
        (scale.0 + scale.1 * lo) as f32,
        (scale.0 + scale.1 * hi) as f32,
    )
}

/// How much hue `h` (degrees, `0..360`) is in `lo..hi` (1 inside, fading
/// over [`HUE_FEATHER`] degrees outside, around the circle).
fn membership(h: f32, (lo, hi): (f32, f32)) -> f32 {
    let inside = |h: f32| h >= lo && h <= hi;
    if inside(h) || inside(h + 360.0) || inside(h - 360.0) {
        return 1.0;
    }
    let distance = |b: f32| {
        let d = (h - b).abs() % 360.0;
        d.min(360.0 - d)
    };
    (1.0 - distance(lo).min(distance(hi)) / HUE_FEATHER).max(0.0)
}

/// Removes the fringes of `lens` from a `width x height` window (`data`
/// interleaved RGB in `lens.space`).
pub(crate) fn defringe_window(
    data: &mut [f32],
    width: usize,
    height: usize,
    lens: &LensRender,
    radius: usize,
) {
    let d = &lens.defringe;
    if !d.is_active() || width == 0 || height == 0 {
        return;
    }
    let to_srgb = |rgb: [f32; 3]| match lens.space {
        LensSpace::LinearSrgb => rgb,
        LensSpace::LinearProPhoto => mat_vec_f32(&PROPHOTO_TO_SRGB_F32, rgb),
    };
    let own_luma = match lens.space {
        LensSpace::LinearSrgb => REC709_LUMA_F32,
        LensSpace::LinearProPhoto => PP_LUMA_F32,
    };
    let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let n = width * height;
    let mut lightness = vec![0.0f32; n];
    for (l, px) in lightness.iter_mut().zip(data.chunks_exact(3)) {
        let s = to_srgb([px[0], px[1], px[2]]);
        *l = dot(REC709_LUMA_F32, s).max(0.0).sqrt();
    }
    let mut edge = vec![0.0f32; n];
    for y in 0..height {
        let (up, down) = (y.saturating_sub(1), (y + 1).min(height - 1));
        for x in 0..width {
            let (left, right) = (x.saturating_sub(1), (x + 1).min(width - 1));
            let gx = (lightness[y * width + right] - lightness[y * width + left]) * 0.5;
            let gy = (lightness[down * width + x] - lightness[up * width + x]) * 0.5;
            edge[y * width + x] = smoothstep(EDGE_LO, EDGE_HI, (gx * gx + gy * gy).sqrt());
        }
    }
    let near = dilate(&edge, width, height, radius);
    let purple = degrees(PURPLE_HUE, d.purple.hue_lo, d.purple.hue_hi);
    let green = degrees(GREEN_HUE, d.green.hue_lo, d.green.hue_hi);
    let (purple_amount, green_amount) = (
        (d.purple.amount / 100.0) as f32,
        (d.green.amount / 100.0) as f32,
    );
    for (px, &near) in data.chunks_exact_mut(3).zip(&near) {
        if near <= 0.0 {
            continue;
        }
        let rgb = [px[0], px[1], px[2]];
        let s = to_srgb(rgb);
        let y = dot(REC709_LUMA_F32, s).max(0.0);
        let a = s[0] - 0.5 * (s[1] + s[2]);
        let b = 0.866_025_4 * (s[1] - s[2]);
        let chroma = (a * a + b * b).sqrt();
        let colorful = smoothstep(CHROMA_LO, CHROMA_HI, chroma / (y + 0.01));
        if colorful <= 0.0 {
            continue;
        }
        let mut hue = libm::atan2f(b, a).to_degrees();
        if hue < 0.0 {
            hue += 360.0;
        }
        let w = (purple_amount * membership(hue, purple) + green_amount * membership(hue, green))
            .min(1.0)
            * near
            * colorful;
        if w <= 0.0 {
            continue;
        }
        let neutral = dot(own_luma, rgb);
        for c in px.iter_mut() {
            *c += w * (neutral - *c);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hue_ranges_and_membership() {
        assert_eq!(degrees(PURPLE_HUE, 30.0, 70.0), (265.5, 319.5));
        assert_eq!(degrees(GREEN_HUE, 40.0, 60.0), (108.0, 132.0));
        assert_eq!(membership(280.0, (265.5, 319.5)), 1.0);
        assert!((membership(260.5, (265.5, 319.5)) - 0.5).abs() < 1e-6);
        assert_eq!(membership(200.0, (265.5, 319.5)), 0.0);
        // Around the circle: 2° is 2° from 360°.
        assert!((membership(2.0, (300.0, 360.0)) - 0.8).abs() < 1e-5);
    }

    #[test]
    fn the_radius_follows_the_scale_and_the_margin() {
        assert_eq!(defringe_radius(2560, 128), 5);
        assert_eq!(defringe_radius(1024, 32), 2);
        assert_eq!(defringe_radius(100, 4), 1);
        assert_eq!(defringe_radius(3327, 128), 6);
        assert_eq!(defringe_radius(6000, 256), 12);
        assert_eq!(defringe_radius(8000, 256), 16);
        assert_eq!(defringe_radius(2560, 4), 2);
    }
}
