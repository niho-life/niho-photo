//! `niho-14` (#89, `NIHO14.md`): the `niho-6` H/S response of `niho-13`
//! with a lighter analysis. The response, its networks' coefficients, the
//! 750px analysis image and the gain are `niho-13`'s; two steps of the
//! analysis are computed more cheaply, so its maps (and pixels) differ from
//! `niho-13`'s by rounding-size amounts:
//!
//! - Features: the local means of the two large levels (σ = 64 and 128
//!   analysis pixels) blur the `ln` / `y` planes area-averaged onto a grid
//!   4 times coarser (σ and the 4σ radius in that grid's spacing, the same
//!   reflect border) and are read back bilinearly at each analysis pixel
//!   ([`LOCAL_REDUCTIONS`]). Everything else is the frozen extraction.
//! - Networks: the same weights in `f32`, four pixels per SIMD vector, with
//!   `exp`-based `tanh` / softplus accurate to a few `f32` ulps ([`exp`]).
//!
//! Only IEEE add / sub / mul / div, compares, selects, round-to-nearest-even
//! and exponent-bit scaling, in a fixed order and without FMA: native
//! (NEON), wasm (simd128) and the portable lanes give the same bits.

use crate::niho6_response::{self, CoefficientMaps, Features, ResponseError};
use crate::raw_response::{self, FEATURE_COUNT};
use std::sync::OnceLock;

/// Reduction of the local levels σ = 4, 16, 64, 128 (1: the frozen
/// full-size blur).
pub const LOCAL_REDUCTIONS: [usize; 4] = [1, 1, 4, 4];

/// The 26 features of a linear ProPhoto analysis image, `niho-14`'s way.
pub fn features(
    linear_prophoto_rgb: &[f32],
    width: usize,
    height: usize,
) -> Result<Features, ResponseError> {
    let vectors =
        raw_response::feature_vectors_reduced(linear_prophoto_rgb, width, height, LOCAL_REDUCTIONS)
            .map_err(ResponseError::Features)?;
    Ok(Features {
        width,
        height,
        vectors,
    })
}

const N: usize = FEATURE_COUNT;
const H1: usize = 8;
const H2: usize = 4;

/// One response's network in `f32`.
struct Network {
    features: [usize; N],
    mean: [f32; N],
    scale: [f32; N],
    w1: [[f32; H1]; N],
    b1: [f32; H1],
    w2: [[f32; H2]; H1],
    b2: [f32; H2],
    w3: [[f32; 2]; H2],
    b3: [f32; 2],
}

impl Network {
    fn new(model: &niho6_response::Model) -> Result<Self, String> {
        if (model.features.len(), model.hidden1, model.hidden2) != (N, H1, H2) {
            return Err(format!(
                "niho-14 networks are {N}-{H1}-{H2}, got {}-{}-{}",
                model.features.len(),
                model.hidden1,
                model.hidden2
            ));
        }
        let w = |i: usize| model.weights[i] as f32;
        let mut network = Network {
            features: [0; N],
            mean: [0.0; N],
            scale: [0.0; N],
            w1: [[0.0; H1]; N],
            b1: [0.0; H1],
            w2: [[0.0; H2]; H1],
            b2: [0.0; H2],
            w3: [[0.0; 2]; H2],
            b3: [0.0; 2],
        };
        for i in 0..N {
            network.features[i] = model.features[i];
            network.mean[i] = model.mean[i] as f32;
            network.scale[i] = model.scale[i] as f32;
            for o in 0..H1 {
                network.w1[i][o] = w(i * H1 + o);
            }
        }
        let b1 = N * H1;
        let w2 = b1 + H1;
        let b2 = w2 + H1 * H2;
        let w3 = b2 + H2;
        let b3 = w3 + H2 * 2;
        for o in 0..H1 {
            network.b1[o] = w(b1 + o);
            for p in 0..H2 {
                network.w2[o][p] = w(w2 + o * H2 + p);
            }
        }
        for p in 0..H2 {
            network.b2[p] = w(b2 + p);
            for q in 0..2 {
                network.w3[p][q] = w(w3 + p * 2 + q);
            }
        }
        network.b3 = [w(b3), w(b3 + 1)];
        Ok(network)
    }

    /// `(a, b)` of four pixels: the frozen network's order of operations
    /// (each output adds its bias, then its inputs in order) in `f32`.
    #[inline(always)]
    fn infer<V: Lanes>(&self, x: &[V; N]) -> [V; 2] {
        let mut input = [V::splat(0.0); N];
        for i in 0..N {
            input[i] = clamp6(
                x[self.features[i]]
                    .sub(V::splat(self.mean[i]))
                    .div(V::splat(self.scale[i])),
            );
        }
        let mut first = [V::splat(0.0); H1];
        for (o, value) in first.iter_mut().enumerate() {
            let mut sum = V::splat(self.b1[o]);
            for (i, x) in input.iter().enumerate() {
                sum = sum.add(x.mul(V::splat(self.w1[i][o])));
            }
            *value = tanh(sum);
        }
        let mut second = [V::splat(0.0); H2];
        for (p, value) in second.iter_mut().enumerate() {
            let mut sum = V::splat(self.b2[p]);
            for (o, x) in first.iter().enumerate() {
                sum = sum.add(x.mul(V::splat(self.w2[o][p])));
            }
            *value = tanh(sum);
        }
        let mut out = [V::splat(0.0); 2];
        for (q, value) in out.iter_mut().enumerate() {
            let mut sum = V::splat(self.b3[q]);
            for (p, x) in second.iter().enumerate() {
                sum = sum.add(x.mul(V::splat(self.w3[p][q])));
            }
            *value = softplus(sum);
        }
        out
    }
}

struct Networks {
    highlight: Network,
    shadow: Network,
}

fn networks() -> Result<&'static Networks, ResponseError> {
    static NETWORKS: OnceLock<Result<Networks, String>> = OnceLock::new();
    NETWORKS
        .get_or_init(|| {
            let models = niho6_response::models().map_err(|e| e.to_string())?;
            Ok(Networks {
                highlight: Network::new(&models.highlight)?,
                shadow: Network::new(&models.shadow)?,
            })
        })
        .as_ref()
        .map_err(|m| ResponseError::EmbeddedModel(m.clone()))
}

/// The coefficient maps of `features` seen at `exposure_ev` (`logY` and
/// `meanLogY` move by it, as `niho-13`).
pub fn coefficient_maps_at(
    features: &Features,
    exposure_ev: f64,
) -> Result<CoefficientMaps, ResponseError> {
    let networks = networks()?;
    let pixels = features.vectors.len();
    let shift = exposure_ev as f32;
    let mut maps = CoefficientMaps {
        width: features.width,
        height: features.height,
        highlight_a: vec![0.0; pixels],
        highlight_b: vec![0.0; pixels],
        shadow_a: vec![0.0; pixels],
        shadow_b: vec![0.0; pixels],
    };
    for start in (0..pixels).step_by(4) {
        let count = (pixels - start).min(4);
        let mut lanes = [[0.0_f32; 4]; N];
        for lane in 0..4 {
            // The last group repeats its last pixel.
            let mut vector = features.vectors[start + lane.min(count - 1)];
            if shift != 0.0 {
                for index in niho6_response::EXPOSURE_FEATURES {
                    vector[index] += shift;
                }
            }
            for (feature, slot) in vector.iter().zip(lanes.iter_mut()) {
                slot[lane] = *feature;
            }
        }
        let [ha, hb, sa, sb] = infer_both(networks, &lanes);
        let end = start + count;
        maps.highlight_a[start..end].copy_from_slice(&ha[..count]);
        maps.highlight_b[start..end].copy_from_slice(&hb[..count]);
        maps.shadow_a[start..end].copy_from_slice(&sa[..count]);
        maps.shadow_b[start..end].copy_from_slice(&sb[..count]);
    }
    Ok(maps)
}

/// The highlight and shadow `(a, b)` of four pixels on this target's lanes.
/// Not inlined into the pixel loop: a wasm engine that starts in a baseline
/// tier moves this call to its optimized code while the loop still runs
/// (the first analysis after opening a photo).
#[inline(never)]
fn infer_both(networks: &Networks, lanes: &[[f32; 4]; N]) -> [[f32; 4]; 4] {
    #[cfg(target_arch = "aarch64")]
    {
        infer_on::<neon::Neon>(networks, lanes)
    }
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        infer_on::<wasm::Wasm>(networks, lanes)
    }
    #[cfg(not(any(
        target_arch = "aarch64",
        all(target_arch = "wasm32", target_feature = "simd128")
    )))]
    {
        infer_on::<Portable>(networks, lanes)
    }
}

#[inline(always)]
fn infer_on<V: Lanes>(networks: &Networks, lanes: &[[f32; 4]; N]) -> [[f32; 4]; 4] {
    let x: [V; N] = std::array::from_fn(|i| V::load(lanes[i]));
    let [ha, hb] = networks.highlight.infer(&x);
    let [sa, sb] = networks.shadow.infer(&x);
    [ha.store(), hb.store(), sa.store(), sb.store()]
}

/// The portable lanes' maps, for checking a target's SIMD against them.
#[doc(hidden)]
pub fn coefficient_maps_portable(
    features: &Features,
    exposure_ev: f64,
) -> Result<CoefficientMaps, ResponseError> {
    let networks = networks()?;
    let pixels = features.vectors.len();
    let shift = exposure_ev as f32;
    let mut out = [
        Vec::with_capacity(pixels),
        Vec::with_capacity(pixels),
        Vec::with_capacity(pixels),
        Vec::with_capacity(pixels),
    ];
    for vector in &features.vectors {
        let mut vector = *vector;
        if shift != 0.0 {
            for index in niho6_response::EXPOSURE_FEATURES {
                vector[index] += shift;
            }
        }
        let lanes: [[f32; 4]; N] = std::array::from_fn(|i| [vector[i]; 4]);
        for (map, values) in out.iter_mut().zip(infer_on::<Portable>(networks, &lanes)) {
            map.push(values[0]);
        }
    }
    let [highlight_a, highlight_b, shadow_a, shadow_b] = out;
    Ok(CoefficientMaps {
        width: features.width,
        height: features.height,
        highlight_a,
        highlight_b,
        shadow_a,
        shadow_b,
    })
}

#[inline(always)]
fn clamp6<V: Lanes>(x: V) -> V {
    let low = V::splat(-6.0);
    let high = V::splat(6.0);
    let x = V::select(x.lt(low), low, x);
    V::select(x.gt(high), high, x)
}

/// `e^x` for `x <= 0`: `x = n·ln 2 + r` (`n` the nearest integer to
/// `x/ln 2`, `ln 2` split in an exact high part and the rest, `|r| <= ln 2 / 2`),
/// `e^r` by its Taylor series to `r^7/7!` (the next term is below `f32`
/// precision there) and `2^n` by exponent bits. `x` is clamped at -87 (the
/// result stays a normal number). A few ulps from the exact value.
#[inline(always)]
fn exp<V: Lanes>(x: V) -> V {
    const LN_2_HIGH: f32 = 355.0 / 512.0;
    const LN_2_LOW: f32 = (core::f64::consts::LN_2 - 355.0 / 512.0) as f32;
    let low = V::splat(-87.0);
    let x = V::select(x.lt(low), low, x);
    let n = x.mul(V::splat(core::f32::consts::LOG2_E)).round_even();
    let r = x
        .sub(n.mul(V::splat(LN_2_HIGH)))
        .sub(n.mul(V::splat(LN_2_LOW)));
    // 1/2! + r/3! + … + r^5/7!, then e^r = 1 + r + r^2·(that).
    let mut p = V::splat(1.0 / 5040.0);
    for factorial in [720.0_f32, 120.0, 24.0, 6.0, 2.0] {
        p = p.mul(r).add(V::splat(1.0 / factorial));
    }
    let y = p.mul(r.mul(r)).add(r).add(V::splat(1.0));
    y.mul(V::pow2(n))
}

/// `tanh x = ±(1 − t)/(1 + t)`, `t = e^{−2|x|}`, `|x|` clamped at 9 (the
/// `f32` tanh is 1 within an ulp there).
#[inline(always)]
fn tanh<V: Lanes>(x: V) -> V {
    let nine = V::splat(9.0);
    let a = x.abs();
    let a = V::select(a.gt(nine), nine, a);
    let t = exp(V::splat(-2.0).mul(a));
    let one = V::splat(1.0);
    one.sub(t).div(one.add(t)).flip_sign_by(x)
}

/// `max(v, 0) + ln(1 + e^{−|v|})`, the logarithm by its atanh series
/// `ln(1 + u) = 2s(1 + s²/3 + … + s¹⁴/15)`, `s = u/(2 + u) <= 1/3`.
#[inline(always)]
fn softplus<V: Lanes>(v: V) -> V {
    let zero = V::splat(0.0);
    let u = exp(zero.sub(v.abs()));
    let s = u.div(V::splat(2.0).add(u));
    let s2 = s.mul(s);
    let mut series = V::splat(1.0 / 15.0);
    for k in [13.0_f32, 11.0, 9.0, 7.0, 5.0, 3.0] {
        series = series.mul(s2).add(V::splat(1.0 / k));
    }
    let series = series.mul(s2).add(V::splat(1.0));
    let log = V::splat(2.0).mul(s).mul(series);
    V::select(v.gt(zero), v, zero).add(log)
}

/// Four `f32` lanes. Masks are lanes of all-one or all-zero bits.
trait Lanes: Copy {
    fn splat(value: f32) -> Self;
    fn load(values: [f32; 4]) -> Self;
    fn store(self) -> [f32; 4];
    fn add(self, other: Self) -> Self;
    fn sub(self, other: Self) -> Self;
    fn mul(self, other: Self) -> Self;
    fn div(self, other: Self) -> Self;
    fn abs(self) -> Self;
    /// Round to the nearest integer, ties to even.
    fn round_even(self) -> Self;
    fn lt(self, other: Self) -> Self;
    fn gt(self, other: Self) -> Self;
    /// `mask ? yes : no` per lane.
    fn select(mask: Self, yes: Self, no: Self) -> Self;
    /// `self` with its sign bit flipped where `of` has the sign bit set.
    fn flip_sign_by(self, of: Self) -> Self;
    /// `2^n` for integral `n` in `[-126, 127]`.
    fn pow2(n: Self) -> Self;
}

#[derive(Clone, Copy)]
struct Portable([f32; 4]);

impl Portable {
    #[inline(always)]
    fn map(self, f: impl Fn(f32) -> f32) -> Self {
        Self(self.0.map(f))
    }
    #[inline(always)]
    fn zip(self, other: Self, f: impl Fn(f32, f32) -> f32) -> Self {
        Self(std::array::from_fn(|i| f(self.0[i], other.0[i])))
    }
    #[inline(always)]
    fn mask(condition: bool) -> f32 {
        f32::from_bits(if condition { u32::MAX } else { 0 })
    }
}

impl Lanes for Portable {
    fn splat(value: f32) -> Self {
        Self([value; 4])
    }
    fn load(values: [f32; 4]) -> Self {
        Self(values)
    }
    fn store(self) -> [f32; 4] {
        self.0
    }
    fn add(self, other: Self) -> Self {
        self.zip(other, |a, b| a + b)
    }
    fn sub(self, other: Self) -> Self {
        self.zip(other, |a, b| a - b)
    }
    fn mul(self, other: Self) -> Self {
        self.zip(other, |a, b| a * b)
    }
    fn div(self, other: Self) -> Self {
        self.zip(other, |a, b| a / b)
    }
    fn abs(self) -> Self {
        self.map(f32::abs)
    }
    fn round_even(self) -> Self {
        self.map(f32::round_ties_even)
    }
    fn lt(self, other: Self) -> Self {
        self.zip(other, |a, b| Self::mask(a < b))
    }
    fn gt(self, other: Self) -> Self {
        self.zip(other, |a, b| Self::mask(a > b))
    }
    fn select(mask: Self, yes: Self, no: Self) -> Self {
        Self(std::array::from_fn(|i| {
            let m = mask.0[i].to_bits();
            f32::from_bits((yes.0[i].to_bits() & m) | (no.0[i].to_bits() & !m))
        }))
    }
    fn flip_sign_by(self, of: Self) -> Self {
        self.zip(of, |a, b| {
            f32::from_bits(a.to_bits() ^ (b.to_bits() & 0x8000_0000))
        })
    }
    fn pow2(n: Self) -> Self {
        n.map(|n| f32::from_bits(((n as i32 + 127) as u32) << 23))
    }
}

#[cfg(target_arch = "aarch64")]
mod neon {
    use super::Lanes;
    use core::arch::aarch64::*;

    #[derive(Clone, Copy)]
    pub(super) struct Neon(float32x4_t);

    // SAFETY (every method): NEON is part of the aarch64 baseline; loads and
    // stores read and write a local array.
    impl Lanes for Neon {
        #[inline(always)]
        fn splat(value: f32) -> Self {
            unsafe { Self(vdupq_n_f32(value)) }
        }
        #[inline(always)]
        fn load(values: [f32; 4]) -> Self {
            unsafe { Self(vld1q_f32(values.as_ptr())) }
        }
        #[inline(always)]
        fn store(self) -> [f32; 4] {
            let mut out = [0.0; 4];
            unsafe { vst1q_f32(out.as_mut_ptr(), self.0) };
            out
        }
        #[inline(always)]
        fn add(self, other: Self) -> Self {
            unsafe { Self(vaddq_f32(self.0, other.0)) }
        }
        #[inline(always)]
        fn sub(self, other: Self) -> Self {
            unsafe { Self(vsubq_f32(self.0, other.0)) }
        }
        #[inline(always)]
        fn mul(self, other: Self) -> Self {
            unsafe { Self(vmulq_f32(self.0, other.0)) }
        }
        #[inline(always)]
        fn div(self, other: Self) -> Self {
            unsafe { Self(vdivq_f32(self.0, other.0)) }
        }
        #[inline(always)]
        fn abs(self) -> Self {
            unsafe { Self(vabsq_f32(self.0)) }
        }
        #[inline(always)]
        fn round_even(self) -> Self {
            unsafe { Self(vrndnq_f32(self.0)) }
        }
        #[inline(always)]
        fn lt(self, other: Self) -> Self {
            unsafe { Self(vreinterpretq_f32_u32(vcltq_f32(self.0, other.0))) }
        }
        #[inline(always)]
        fn gt(self, other: Self) -> Self {
            unsafe { Self(vreinterpretq_f32_u32(vcgtq_f32(self.0, other.0))) }
        }
        #[inline(always)]
        fn select(mask: Self, yes: Self, no: Self) -> Self {
            unsafe { Self(vbslq_f32(vreinterpretq_u32_f32(mask.0), yes.0, no.0)) }
        }
        #[inline(always)]
        fn flip_sign_by(self, of: Self) -> Self {
            unsafe {
                let sign = vandq_u32(vreinterpretq_u32_f32(of.0), vdupq_n_u32(0x8000_0000));
                Self(vreinterpretq_f32_u32(veorq_u32(
                    vreinterpretq_u32_f32(self.0),
                    sign,
                )))
            }
        }
        #[inline(always)]
        fn pow2(n: Self) -> Self {
            unsafe {
                let biased = vaddq_s32(vcvtq_s32_f32(n.0), vdupq_n_s32(127));
                Self(vreinterpretq_f32_s32(vshlq_n_s32::<23>(biased)))
            }
        }
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod wasm {
    use super::Lanes;
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    pub(super) struct Wasm(v128);

    impl Lanes for Wasm {
        #[inline(always)]
        fn splat(value: f32) -> Self {
            Self(f32x4_splat(value))
        }
        #[inline(always)]
        fn load(values: [f32; 4]) -> Self {
            Self(f32x4(values[0], values[1], values[2], values[3]))
        }
        #[inline(always)]
        fn store(self) -> [f32; 4] {
            [
                f32x4_extract_lane::<0>(self.0),
                f32x4_extract_lane::<1>(self.0),
                f32x4_extract_lane::<2>(self.0),
                f32x4_extract_lane::<3>(self.0),
            ]
        }
        #[inline(always)]
        fn add(self, other: Self) -> Self {
            Self(f32x4_add(self.0, other.0))
        }
        #[inline(always)]
        fn sub(self, other: Self) -> Self {
            Self(f32x4_sub(self.0, other.0))
        }
        #[inline(always)]
        fn mul(self, other: Self) -> Self {
            Self(f32x4_mul(self.0, other.0))
        }
        #[inline(always)]
        fn div(self, other: Self) -> Self {
            Self(f32x4_div(self.0, other.0))
        }
        #[inline(always)]
        fn abs(self) -> Self {
            Self(f32x4_abs(self.0))
        }
        #[inline(always)]
        fn round_even(self) -> Self {
            Self(f32x4_nearest(self.0))
        }
        #[inline(always)]
        fn lt(self, other: Self) -> Self {
            Self(f32x4_lt(self.0, other.0))
        }
        #[inline(always)]
        fn gt(self, other: Self) -> Self {
            Self(f32x4_gt(self.0, other.0))
        }
        #[inline(always)]
        fn select(mask: Self, yes: Self, no: Self) -> Self {
            Self(v128_bitselect(yes.0, no.0, mask.0))
        }
        #[inline(always)]
        fn flip_sign_by(self, of: Self) -> Self {
            Self(v128_xor(self.0, v128_and(of.0, u32x4_splat(0x8000_0000))))
        }
        #[inline(always)]
        fn pow2(n: Self) -> Self {
            let biased = i32x4_add(i32x4_trunc_sat_f32x4(n.0), i32x4_splat(127));
            Self(i32x4_shl(biased, 23))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approximations_are_within_a_few_ulps() {
        let mut worst = [0.0_f64; 3];
        for i in 0..=200_000 {
            let x = -20.0 + 40.0 * i as f64 / 200_000.0;
            let lanes = Portable::splat(x as f32);
            let t = f64::from(tanh(lanes).0[0]);
            worst[0] = worst[0].max((t - (x as f32 as f64).tanh()).abs());
            let s = f64::from(softplus(lanes).0[0]);
            let v = x as f32 as f64;
            let exact = v.max(0.0) + (-v.abs()).exp().ln_1p();
            worst[1] = worst[1].max((s - exact).abs() / exact.max(1e-30));
            if x <= 0.0 {
                let e = f64::from(exp(lanes).0[0]);
                let exact = v.exp();
                worst[2] = worst[2].max((e - exact).abs() / exact);
            }
        }
        assert!(worst[0] < 1.5e-7, "tanh absolute {}", worst[0]);
        assert!(worst[1] < 4e-7, "softplus relative {}", worst[1]);
        assert!(worst[2] < 1.5e-7, "exp relative {}", worst[2]);
    }

    #[test]
    fn target_lanes_are_the_portable_lanes() {
        let networks = networks().expect("networks");
        let mut state = 0x1b87_3593u32;
        for _ in 0..2000 {
            let lanes: [[f32; 4]; N] = std::array::from_fn(|_| {
                std::array::from_fn(|_| {
                    state ^= state << 13;
                    state ^= state >> 17;
                    state ^= state << 5;
                    (state as f64 / u32::MAX as f64 * 24.0 - 12.0) as f32
                })
            });
            let target = infer_both(networks, &lanes);
            let portable = infer_on::<Portable>(networks, &lanes);
            for (a, b) in target.iter().flatten().zip(portable.iter().flatten()) {
                assert_eq!(a.to_bits(), b.to_bits());
            }
        }
    }
}
