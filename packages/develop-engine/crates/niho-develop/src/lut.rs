//! 64^3 color cubes, baked and applied exactly like Photo Bench's
//! `AdobeBaseRenderer.bakeCube` / `applyCube`:
//!
//! - grid coordinate `i` samples linear `(i / 63)^1.8` (gamma-1.8 index);
//! - the transform's output is clipped to `[0, 1]` and stored gamma encoded
//!   (`^(1/1.8)`), red fastest, then green, then blue, **at 8 bits**: Core
//!   Image's `CIColorCube` keeps the cube entries at 8-bit precision in
//!   Photo Bench's production rendering (measured: with 8-bit entries the
//!   per-patch difference to photobench-engine drops from 0.45-0.60 to
//!   0.29-0.33 levels, the JPEG reference's own noise floor being 0.28;
//!   interpolation-weight precision made no difference);
//! - applying encodes the input with `^(1/1.8)` (`CIGammaAdjust`), clamps it
//!   to `[0, 1]` (`CIColorCube` clamps its input), interpolates trilinearly
//!   and decodes with `^1.8`.
//!
//! Consecutive cubes can pass values in the encoded domain
//! ([`Cube::apply_encoded`]): Photo Bench's decode/encode pair between two
//! cubes is a no-op past float rounding.

pub const CUBE_DIMENSION: usize = 64;
pub const CUBE_GAMMA: f64 = 1.8;

#[derive(Clone)]
pub struct Cube {
    n: usize,
    /// `n^3` encoded outputs, red fastest. The values are 8-bit (see the
    /// module comment); each entry keeps `code / 255` in `f32` lanes
    /// (`r, g, b, 0`) so the trilinear interpolation runs on all channels
    /// at once (the same per-channel arithmetic as on the bytes).
    data: Vec<[f32; 4]>,
}

impl std::fmt::Debug for Cube {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cube").field("n", &self.n).finish()
    }
}

/// `c = c0 + (c1 - c0) * t` along x, then y, then z, per channel: corners
/// `000, 100, 010, 110, 001, 101, 011, 111`.
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline]
pub(crate) fn trilinear(c: &[[f32; 4]; 8], tx: f32, ty: f32, tz: f32) -> [f32; 3] {
    let lerp = |a: [f32; 4], b: [f32; 4], t: f32| -> [f32; 4] {
        [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
            a[3] + (b[3] - a[3]) * t,
        ]
    };
    let c00 = lerp(c[0], c[1], tx);
    let c10 = lerp(c[2], c[3], tx);
    let c01 = lerp(c[4], c[5], tx);
    let c11 = lerp(c[6], c[7], tx);
    let c0 = lerp(c00, c10, ty);
    let c1 = lerp(c01, c11, ty);
    let v = lerp(c0, c1, tz);
    [v[0], v[1], v[2]]
}

/// The same interpolation on `f32x4` lanes (plain IEEE add / sub / mul per
/// lane, no fused operations: bit-identical to the scalar version).
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
pub(crate) fn trilinear(c: &[[f32; 4]; 8], tx: f32, ty: f32, tz: f32) -> [f32; 3] {
    use core::arch::wasm32::{
        f32x4, f32x4_add, f32x4_extract_lane, f32x4_mul, f32x4_splat, f32x4_sub, v128,
    };
    let v = |a: [f32; 4]| f32x4(a[0], a[1], a[2], a[3]);
    let lerp = |a: v128, b: v128, t: v128| f32x4_add(a, f32x4_mul(f32x4_sub(b, a), t));
    let (tx, ty, tz) = (f32x4_splat(tx), f32x4_splat(ty), f32x4_splat(tz));
    let c00 = lerp(v(c[0]), v(c[1]), tx);
    let c10 = lerp(v(c[2]), v(c[3]), tx);
    let c01 = lerp(v(c[4]), v(c[5]), tx);
    let c11 = lerp(v(c[6]), v(c[7]), tx);
    let c0 = lerp(c00, c10, ty);
    let c1 = lerp(c01, c11, ty);
    let r = lerp(c0, c1, tz);
    [
        f32x4_extract_lane::<0>(r),
        f32x4_extract_lane::<1>(r),
        f32x4_extract_lane::<2>(r),
    ]
}

/// `c0 + (a - c0) w1 + (b - a) w2 + (c1 - b) w3` per channel (the
/// tetrahedral interpolation of [`Cube::lookup_tetrahedral`]).
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline]
fn tetrahedral(
    c0: [f32; 4],
    a: [f32; 4],
    b: [f32; 4],
    c1: [f32; 4],
    w1: f32,
    w2: f32,
    w3: f32,
) -> [f32; 3] {
    let mix = |c: usize| c0[c] + (a[c] - c0[c]) * w1 + (b[c] - a[c]) * w2 + (c1[c] - b[c]) * w3;
    [mix(0), mix(1), mix(2)]
}

/// The same on `f32x4` lanes (plain IEEE add / sub / mul in the same order:
/// bit-identical to the scalar version).
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn tetrahedral(
    c0: [f32; 4],
    a: [f32; 4],
    b: [f32; 4],
    c1: [f32; 4],
    w1: f32,
    w2: f32,
    w3: f32,
) -> [f32; 3] {
    use core::arch::wasm32::{
        f32x4, f32x4_add, f32x4_extract_lane, f32x4_mul, f32x4_splat, f32x4_sub,
    };
    let v = |p: [f32; 4]| f32x4(p[0], p[1], p[2], p[3]);
    let (c0, a, b, c1) = (v(c0), v(a), v(b), v(c1));
    let r = f32x4_add(
        f32x4_add(
            f32x4_add(c0, f32x4_mul(f32x4_sub(a, c0), f32x4_splat(w1))),
            f32x4_mul(f32x4_sub(b, a), f32x4_splat(w2)),
        ),
        f32x4_mul(f32x4_sub(c1, b), f32x4_splat(w3)),
    );
    [
        f32x4_extract_lane::<0>(r),
        f32x4_extract_lane::<1>(r),
        f32x4_extract_lane::<2>(r),
    ]
}

impl Cube {
    /// Bakes `transform` (linear in, linear out, `f64`) on the grid.
    pub fn bake(transform: &(dyn Fn([f64; 3]) -> [f64; 3] + Sync)) -> Self {
        Self::bake_with_dimension(CUBE_DIMENSION, transform)
    }

    pub fn bake_with_dimension(
        n: usize,
        transform: &(dyn Fn([f64; 3]) -> [f64; 3] + Sync),
    ) -> Self {
        Self::bake_with_precision(n, false, transform)
    }

    /// NIHO 3's frozen R115 cube: 64 nodes per edge with f32 entries (the
    /// research name "float64grid" referred to the 64-edge grid, not f64 values).
    pub fn bake_float(transform: &(dyn Fn([f64; 3]) -> [f64; 3] + Sync)) -> Self {
        Self::bake_float_with_dimension(CUBE_DIMENSION, transform)
    }

    /// Bakes an `n^3` cube with unquantized f32 entries. This keeps the same
    /// gamma-1.8 grid, clamps and trilinear application as [`Cube::bake`];
    /// only the 8-bit entry quantization is omitted.
    pub fn bake_float_with_dimension(
        n: usize,
        transform: &(dyn Fn([f64; 3]) -> [f64; 3] + Sync),
    ) -> Self {
        assert!(n >= 2, "a color cube needs at least two nodes per edge");
        Self::bake_with_precision(n, true, transform)
    }

    fn bake_with_precision(
        n: usize,
        float_entries: bool,
        transform: &(dyn Fn([f64; 3]) -> [f64; 3] + Sync),
    ) -> Self {
        let denominator = (n - 1) as f64;
        let linear: Vec<f64> = (0..n)
            .map(|i| libm::pow(i as f64 / denominator, CUBE_GAMMA))
            .collect();
        let mut data = vec![[0.0f32; 4]; n * n * n];
        let encode = |v: f64| -> f32 {
            let encoded = libm::pow(v.clamp(0.0, 1.0), 1.0 / CUBE_GAMMA);
            if float_entries {
                encoded as f32
            } else {
                let code = libm::round(encoded * 255.0) as u8;
                code as f32 * (1.0 / 255.0)
            }
        };
        // Every node reads only its own coordinates, so the rows of red
        // (one per blue and green) may run on different threads (#150).
        crate::par::for_each_row_mut(&mut data, n, |row, entries| {
            let (b, g) = (row / n, row % n);
            for (r, entry) in entries.iter_mut().enumerate() {
                let out = transform([linear[r], linear[g], linear[b]]);
                *entry = [encode(out[0]), encode(out[1]), encode(out[2]), 0.0];
            }
        });
        Self { n, data }
    }

    /// A cube with the given `n^3` entries (red fastest), kept in `f32`
    /// (not 8-bit): drag-frame tails, not Photo Bench's cubes.
    pub fn from_entries(n: usize, entries: impl Iterator<Item = [f32; 3]>) -> Self {
        let data: Vec<[f32; 4]> = entries.map(|v| [v[0], v[1], v[2], 0.0]).collect();
        assert_eq!(data.len(), n * n * n);
        Self { n, data }
    }

    pub fn dimension(&self) -> usize {
        self.n
    }

    /// Lookup of an encoded, already `[0,1]`-clamped coordinate.
    #[inline]
    pub fn lookup_encoded(&self, e: [f32; 3]) -> [f32; 3] {
        self.lookup_trilinear(e)
    }

    /// Trilinear lookup of an encoded, already `[0,1]`-clamped coordinate.
    #[inline]
    pub fn lookup_trilinear(&self, e: [f32; 3]) -> [f32; 3] {
        let n = self.n;
        let scale = (n - 1) as f32;
        let fx = e[0] * scale;
        let fy = e[1] * scale;
        let fz = e[2] * scale;
        let x0 = (fx as usize).min(n - 2);
        let y0 = (fy as usize).min(n - 2);
        let z0 = (fz as usize).min(n - 2);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let tz = fz - z0 as f32;
        let stride_y = n;
        let stride_z = n * n;
        let base = z0 * stride_z + y0 * stride_y + x0;
        // The 8 corners (one bounds check for the whole span).
        let d = &self.data[base..base + stride_z + stride_y + 2];
        let corners = [
            d[0],
            d[1],
            d[stride_y],
            d[stride_y + 1],
            d[stride_z],
            d[stride_z + 1],
            d[stride_z + stride_y],
            d[stride_z + stride_y + 1],
        ];
        trilinear(&corners, tx, ty, tz)
    }

    /// Tetrahedral lookup of an already `[0,1]`-clamped coordinate: the 4
    /// corners of the tetrahedron (of the 6 along the cell's diagonal) that
    /// holds the point, from `c000` along the axis of the largest fraction,
    /// then the second, to `c111`. Drag-frame tails only (smaller errors
    /// than trilinear on color transforms, half the corners); Photo Bench's
    /// cubes stay trilinear. The corners are chosen with selects, not
    /// branches (the order of the fractions changes from pixel to pixel).
    #[inline]
    pub fn lookup_tetrahedral(&self, e: [f32; 3]) -> [f32; 3] {
        let n = self.n;
        let scale = (n - 1) as f32;
        let fx = e[0] * scale;
        let fy = e[1] * scale;
        let fz = e[2] * scale;
        let x0 = (fx as usize).min(n - 2);
        let y0 = (fy as usize).min(n - 2);
        let z0 = (fz as usize).min(n - 2);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let tz = fz - z0 as f32;
        let (sx, sy, sz) = (1, n, n * n);
        let base = z0 * sz + y0 * sy + x0;
        let d = &self.data[base..base + sx + sy + sz + 1];
        let x_max = tx >= ty && tx >= tz;
        let o_max = if x_max {
            sx
        } else if ty >= tz {
            sy
        } else {
            sz
        };
        let z_min = tz <= tx && tz <= ty;
        let o_min = if z_min {
            sz
        } else if ty <= tx {
            sy
        } else {
            sx
        };
        let w1 = tx.max(ty).max(tz);
        let w2 = tx.min(ty).max(tx.max(ty).min(tz));
        let w3 = tx.min(ty).min(tz);
        tetrahedral(
            d[0],
            d[o_max],
            d[sx + sy + sz - o_min],
            d[sx + sy + sz],
            w1,
            w2,
            w3,
        )
    }

    /// Linear in, linear out (one full `applyCube`).
    #[inline]
    pub fn apply(&self, rgb: [f32; 3]) -> [f32; 3] {
        decode(self.lookup_encoded(encode(rgb)))
    }

    /// Encoded in (clamped here), encoded out.
    #[inline]
    pub fn apply_encoded(&self, e: [f32; 3]) -> [f32; 3] {
        self.lookup_encoded([
            e[0].clamp(0.0, 1.0),
            e[1].clamp(0.0, 1.0),
            e[2].clamp(0.0, 1.0),
        ])
    }
}

/// `CIGammaAdjust(1/1.8)` followed by `CIColorCube`'s input clamp.
#[inline]
pub fn encode(rgb: [f32; 3]) -> [f32; 3] {
    [encode1(rgb[0]), encode1(rgb[1]), encode1(rgb[2])]
}

#[inline]
fn encode1(v: f32) -> f32 {
    if v <= 0.0 || v.is_nan() {
        0.0
    } else if v >= 1.0 {
        1.0
    } else {
        crate::fastmath::gamma18_encode().eval(v)
    }
}

/// `CIGammaAdjust(1.8)` on a cube output (already in `[0, 1]`).
#[inline]
pub fn decode(e: [f32; 3]) -> [f32; 3] {
    [decode1(e[0]), decode1(e[1]), decode1(e[2])]
}

#[inline]
fn decode1(v: f32) -> f32 {
    crate::fastmath::gamma18_decode().eval(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tetrahedral_lookup_is_exact_on_affine_maps_and_at_nodes() {
        let n = 5;
        let f = |v: [f32; 3]| {
            [
                0.2 + 0.5 * v[0] + 0.1 * v[1],
                0.3 * v[1] + 0.2 * v[2],
                0.9 - 0.4 * v[2] + 0.05 * v[0],
            ]
        };
        let step = 1.0 / (n - 1) as f32;
        let cube = Cube::from_entries(
            n,
            (0..n * n * n).map(|i| {
                f([
                    (i % n) as f32 * step,
                    (i / n % n) as f32 * step,
                    (i / n / n) as f32 * step,
                ])
            }),
        );
        for p in [
            [0.1f32, 0.7, 0.33],
            [0.9, 0.2, 0.5],
            [0.5, 0.5, 0.5],
            [1.0, 0.0, 0.61],
            [0.26, 0.74, 0.99],
        ] {
            let (got, want) = (cube.lookup_tetrahedral(p), f(p));
            for c in 0..3 {
                assert!(
                    (got[c] - want[c]).abs() < 1e-5,
                    "{p:?}: {got:?} vs {want:?}"
                );
            }
        }
        // Nodes return their entries.
        let node = [2.0 * step, 1.0 * step, 3.0 * step];
        assert_eq!(cube.lookup_tetrahedral(node), f(node));
    }

    #[test]
    fn identity_cube_round_trips_in_range_values() {
        let cube = Cube::bake(&|v| v);
        for v in [0.0f32, 1e-4, 0.01, 0.18, 0.5, 0.9, 1.0] {
            let out = cube.apply([v, v * 0.5, v * 0.25]);
            // 8-bit entries: at most half a step in the encoded domain.
            let e = libm::powf(v, 1.0 / 1.8);
            let back = libm::powf(libm::powf(out[0], 1.0 / 1.8), 1.0);
            assert!((back - e).abs() <= 0.5 / 255.0 + 1e-6, "{v} -> {:?}", out);
        }
        // Above 1 clamps like CIColorCube.
        assert_eq!(cube.apply([2.0, -1.0, 0.5])[0], 1.0);
        assert_eq!(cube.apply([2.0, -1.0, 0.5])[1], 0.0);
    }

    #[test]
    fn dimension_aware_float_baker_keeps_unquantized_entries() {
        let quantized = Cube::bake_with_dimension(5, &|v| v);
        let float = Cube::bake_float_with_dimension(5, &|v| v);
        assert_eq!(float.dimension(), 5);
        let coordinate = [0.37f32, 0.51, 0.83];
        let q = quantized.lookup_encoded(coordinate);
        let f = float.lookup_encoded(coordinate);
        assert_ne!(q, f);
        for channel in 0..3 {
            assert!((f[channel] - coordinate[channel]).abs() < 2e-6);
        }
    }
}
