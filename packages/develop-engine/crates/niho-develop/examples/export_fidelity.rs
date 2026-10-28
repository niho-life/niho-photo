//! Export fidelity (#133): the full-size render, reduced to the screen's
//! size, against the screen's own render, on synthetic photos.
//!
//! `cargo run --release --example export_fidelity -- [--long 6000] [--case <name>|all] [--full-only [--neutral]]`
//!
//! The screen opens the photo at long edge 2560 (`Session::open_raster(png,
//! 2560, Lanczos3)`, the working size) and renders it (Final, working
//! size); the export opens it at its own size (`niho-develop-render
//! --raster`, max dimension 0) and renders it the same way. The export is
//! reduced to the screen's size in linear light (Lanczos 3) and the two are
//! compared pixel by pixel in CIEDE2000: `all` over the frame, `roi` over
//! the pixels the effect acts on. Each case also renders the photo without
//! the effect (`neutral`): the floor that the two sizes leave anyway.
//!
//! Cases (`--long` is the photo's long edge, 3:2):
//!
//! - `fringe` / `fringe-wide`: dark branches over a bright neutral sky
//!   with purple fringes on the sky side (fading over 3 / 8 px at the full
//!   size), defringe purple 100;
//! - `chromatic` / `chromatic-weak`: the branches with red and blue
//!   magnified about the center (a corner shift of about 2 px / 0.6 px at
//!   6000 px), removeChromaticAberration;
//! - `brush` / `brush-2048`: a brush surface of 1024 / 2048 px (a disc with
//!   the editor's 1-pixel edge) over a gradient, exposure +1;
//! - `heal` / `heal-large`: a wire across textured grass removed along its
//!   length / a rock removed with one large mark (more than 2^20 hole
//!   pixels at 6000 px);
//! - `sharpen` / `sharpen-edges` / `sharpen-texture`: the branches over a
//!   fine texture / over a flat sky / the texture alone, Amount 80, Radius
//!   1, Detail 25;
//! - `noise`: the branches over a sky with pixel noise (luma and color),
//!   luminance noise reduction 40, color 25.
//!
//! `--sharpen-options` compares the ways the export could sharpen
//! ([`sharpen_options`]).
//!
//! Prints one JSON line per case. `--full-only` renders the full size once
//! (with the effect, or without it with `--neutral`) and prints its time,
//! for `/usr/bin/time -l` to measure the process's peak memory.

use niho_develop::detail::sharpen_linear_srgb;
use niho_develop::mask_surface::{self, MaskSurface};
use niho_develop::pipeline::Rendered;
use niho_develop::research::linear_jpeg_wb::delta_e00;
use niho_develop::resize::resample;
use niho_develop::settings::SharpeningSettings;
use niho_develop::{encode, DevelopSettings, Filter, Quality, Session};
use serde_json::{json, Value};
use std::time::Instant;

const SCREEN: usize = 2560;
const CASES: [&str; 13] = [
    "fringe",
    "fringe-wide",
    "chromatic",
    "chromatic-weak",
    "brush",
    "brush-2048",
    "heal",
    "heal-large",
    "sharpen",
    "sharpen-edges",
    "sharpen-texture",
    "noise",
    "neutral",
];

/// A synthetic photo: linear sRGB at a full-size position, and whether the
/// effect acts there.
type Photo = Box<dyn Fn(f64, f64) -> ([f64; 3], bool)>;

struct Case {
    photo: Photo,
    /// Keys merged into the base settings.
    effect: Value,
    /// A brush surface: its id and PNG.
    surface: Option<(String, Vec<u8>)>,
    /// A full-size point on a vertical edge whose 10-90% width is measured
    /// (row, column), and the half window in full-size pixels.
    edge: Option<(f64, f64, f64)>,
    /// A hole (center, radius in full-size pixels) whose texture is
    /// compared with the ring around it.
    hole: Option<(f64, f64, f64)>,
    /// A full-size point on a branch's edge and the normal toward the sky:
    /// the profile printed across it.
    profile: Option<([f64; 2], [f64; 2])>,
}

// MARK: - Synthetic photos

fn splitmix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

fn lattice(ix: i64, iy: i64, seed: u64) -> f64 {
    let h = splitmix(
        seed ^ (ix as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
            ^ (iy as u64).wrapping_mul(0xc2b2_ae3d_27d4_eb4f),
    );
    (h >> 11) as f64 / (1u64 << 53) as f64
}

/// Smooth value noise (`0..1`) on a lattice of unit cells.
fn value_noise(x: f64, y: f64, seed: u64) -> f64 {
    let (fx, fy) = (x.floor(), y.floor());
    let (tx, ty) = (x - fx, y - fy);
    let (sx, sy) = (tx * tx * (3.0 - 2.0 * tx), ty * ty * (3.0 - 2.0 * ty));
    let (ix, iy) = (fx as i64, fy as i64);
    let a = lattice(ix, iy, seed);
    let b = lattice(ix + 1, iy, seed);
    let c = lattice(ix, iy + 1, seed);
    let d = lattice(ix + 1, iy + 1, seed);
    a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

/// Coverage of a soft-edged shape at signed distance `d` (negative inside;
/// a lens's edge: 10-90% over about 2.6 px).
fn coverage(d: f64) -> f64 {
    1.0 / (1.0 + (d / 0.6).exp())
}

/// Nine straight branches across a `w x h` frame: the distance (full-size
/// pixels) from `(x, y)` to the nearest one's center line.
fn branch_distance(w: f64, h: f64, x: f64, y: f64) -> f64 {
    let (cx, cy) = (w / 2.0, h / 2.0);
    (0..9)
        .map(|k| {
            let (s, c) = (0.37 * k as f64 + 0.2).sin_cos();
            let offset = ((k as f64 * 0.137) % 0.8 - 0.4) * w;
            ((x - cx) * c + (y - cy) * s - offset).abs()
        })
        .fold(f64::INFINITY, f64::min)
}

/// The edge of branch 4 nearest the frame's center (the sky side) and its
/// normal.
fn branch_edge(w: f64, h: f64) -> ([f64; 2], [f64; 2]) {
    let (s, c) = (0.37 * 4.0 + 0.2f64).sin_cos();
    let offset = ((4.0 * 0.137) % 0.8 - 0.4) * w;
    let reach = offset + 0.002 * w;
    ([w / 2.0 + reach * c, h / 2.0 + reach * s], [c, s])
}

fn segment_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    ((p[0] - a[0] - t * dx).powi(2) + (p[1] - a[1] - t * dy).powi(2)).sqrt()
}

fn sky(h: f64, y: f64) -> f64 {
    0.62 + 0.16 * y / h
}

fn grass(x: f64, y: f64) -> [f64; 3] {
    let n = 0.5 * value_noise(x / 5.0, y / 5.0, 1)
        + 0.3 * value_noise(x / 17.0, y / 17.0, 2)
        + 0.2 * value_noise(x / 60.0, y / 60.0, 3);
    let k = 0.6 + 0.8 * n;
    [0.06 * k, 0.13 * k, 0.04 * k]
}

fn base_settings(effect: &Value) -> DevelopSettings {
    let mut v = json!({"engine": "niho-14"});
    for (k, value) in effect.as_object().unwrap() {
        v[k] = value.clone();
    }
    let mut s = DevelopSettings::from_value(&v).unwrap();
    s.v = s.required_version().max(s.v);
    assert!(s.validate().is_empty(), "{:?}", s.validate());
    s
}

fn make_case(name: &str, w: f64, h: f64) -> Case {
    let half = 0.002 * w;
    let plain = |photo: Photo, effect: Value| Case {
        photo,
        effect,
        surface: None,
        edge: None,
        hole: None,
        profile: Some(branch_edge(w, h)),
    };
    match name {
        "fringe" | "fringe-wide" => {
            let reach = if name == "fringe" { 3.0 } else { 8.0 };
            plain(
                Box::new(move |x, y| {
                    let e = branch_distance(w, h, x, y) - half;
                    let dark = coverage(e);
                    let level = sky(h, y);
                    let wf = 0.85 * (-e.max(0.0) / reach).exp();
                    let purple = [0.6, 0.18, 0.95];
                    let rgb = [0, 1, 2].map(|c| {
                        let lit = (1.0 - wf) * level + wf * purple[c] * level / 0.7;
                        (1.0 - dark) * lit + dark * 0.03
                    });
                    (rgb, (-3.0..4.0 * reach + 2.0).contains(&e))
                }),
                json!({"lens": {"defringe": {"purple": {"amount": 100}}}}),
            )
        }
        "chromatic" | "chromatic-weak" => {
            let scale = if name == "chromatic" {
                [1.0006, 0.9995]
            } else {
                [1.000_18, 0.999_84]
            };
            let (cx, cy) = (w / 2.0, h / 2.0);
            let corner = (cx * cx + cy * cy).sqrt();
            plain(
                Box::new(move |x, y| {
                    let at = |s: f64| {
                        let (px, py) = (cx + (x - cx) / s, cy + (y - cy) / s);
                        let dark = coverage(branch_distance(w, h, px, py) - half);
                        (1.0 - dark) * sky(h, py) + dark * 0.03
                    };
                    let e = (branch_distance(w, h, x, y) - half).abs();
                    let rho = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() / corner;
                    ([at(scale[0]), at(1.0), at(scale[1])], e < 8.0 && rho > 0.4)
                }),
                json!({"lens": {"removeChromaticAberration": true}}),
            )
        }
        "brush" | "brush-2048" => {
            let long: u32 = if name == "brush" { 1024 } else { 2048 };
            let (sw, sh) = (long, (long as f64 * h / w).round() as u32);
            // A disc (center 0.3 / 0.5, radius 0.28 of the height) with the
            // editor's 1-pixel edge (`photo-editing-mask-brush.ts`, feather 0).
            let (dcx, dcy, dr) = (0.3 * sw as f64, 0.5 * sh as f64, 0.28 * sh as f64);
            let data = (0..sh)
                .flat_map(|y| (0..sw).map(move |x| (x, y)))
                .map(|(x, y)| {
                    let d =
                        ((x as f64 + 0.5 - dcx).powi(2) + (y as f64 + 0.5 - dcy).powi(2)).sqrt();
                    let t = (dr + 0.5 - d).clamp(0.0, 1.0);
                    (255.0 * t * t * (3.0 - 2.0 * t)).round() as u8
                })
                .collect();
            let png =
                mask_surface::encode_surface_png(&MaskSurface::new(sw, sh, data).unwrap()).unwrap();
            let id = mask_surface::surface_id(&png);
            let k = w / sw as f64;
            let (fcx, fcy, fr) = (dcx * k, dcy * k, dr * k);
            Case {
                photo: Box::new(move |x, y| {
                    let level = 0.05 + 0.12 * x / w + 0.02 * value_noise(x / 3.0, y / 3.0, 7);
                    let d = ((x - fcx).powi(2) + (y - fcy).powi(2)).sqrt();
                    (
                        [level, 0.95 * level, 0.9 * level],
                        (d - fr).abs() < 3.0 * k + 4.0,
                    )
                }),
                effect: json!({"masks": [{
                    "id": "b1", "kind": "brush",
                    "surface": {"id": id, "width": sw, "height": sh},
                    "adjust": {"exposure": 1.0}
                }]}),
                surface: Some((id, png)),
                edge: Some((fcy, fcx + fr, 12.0 * k)),
                hole: None,
                profile: None,
            }
        }
        "heal" => {
            let (a, b) = ([0.05 * w, 0.12 * h], [0.95 * w, 0.8 * h]);
            let radius = 0.0035;
            let reach = radius * w;
            let points: Vec<[f64; 2]> = (0..9)
                .map(|i| {
                    let t = i as f64 / 8.0;
                    [
                        (a[0] + t * (b[0] - a[0])) / w,
                        (a[1] + t * (b[1] - a[1])) / h,
                    ]
                })
                .collect();
            plain(
                Box::new(move |x, y| {
                    let ground = if y < 0.3 * h {
                        let l = sky(h, y);
                        [0.8 * l, 0.9 * l, l]
                    } else {
                        grass(x, y)
                    };
                    let d = segment_distance([x, y], a, b);
                    let wire = coverage(d - 2.0);
                    (ground.map(|c| (1.0 - wire) * c + wire * 0.01), d < reach)
                }),
                json!({"heal": [{"id": "w1", "mode": "remove", "radius": radius, "feather": 0.5, "points": points}]}),
            )
        }
        "heal-large" => {
            let (cx, cy) = (0.5 * w, 0.62 * h);
            let radius = 0.1;
            let reach = radius * w;
            Case {
                photo: Box::new(move |x, y| {
                    let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                    let rock = coverage(d - 0.07 * w);
                    let g = grass(x, y);
                    (g.map(|c| (1.0 - rock) * c + rock * 0.2), d < reach)
                }),
                effect: json!({"heal": [{"id": "r1", "mode": "remove", "radius": radius, "feather": 0.3, "points": [[cx / w, cy / h]]}]}),
                surface: None,
                edge: None,
                hole: Some((cx, cy, reach)),
                profile: None,
            }
        }
        "sharpen" | "sharpen-edges" | "sharpen-texture" => {
            let (bars, texture) = match name {
                "sharpen" => (true, true),
                "sharpen-edges" => (true, false),
                _ => (false, true),
            };
            plain(
                Box::new(move |x, y| {
                    let e = if bars {
                        branch_distance(w, h, x, y) - half
                    } else {
                        f64::INFINITY
                    };
                    let dark = coverage(e);
                    let grain = if texture {
                        0.9 + 0.2 * value_noise(x / 2.5, y / 2.5, 5)
                    } else {
                        1.0
                    };
                    let level = sky(h, y) * grain;
                    (
                        [(1.0 - dark) * level + dark * 0.03; 3],
                        !bars || e.abs() < 8.0,
                    )
                }),
                json!({"detail": {"sharpening": {"amount": 80, "radius": 1, "detail": 25, "masking": 0}, "luminanceNoiseReduction": 0, "colorNoiseReduction": 0}}),
            )
        }
        "noise" => plain(
            Box::new(move |x, y| {
                let e = branch_distance(w, h, x, y) - half;
                let dark = coverage(e);
                let n = lattice(x as i64, y as i64, 11) - 0.5;
                let c = lattice(x as i64, y as i64, 12) - 0.5;
                let level = sky(h, y) * (1.0 + 0.12 * n);
                let rgb = [level * (1.0 + 0.1 * c), level, level * (1.0 - 0.1 * c)];
                (rgb.map(|v| (1.0 - dark) * v + dark * 0.03), true)
            }),
            json!({"detail": {"sharpening": {"amount": 0, "radius": 1, "detail": 25, "masking": 0}, "luminanceNoiseReduction": 40, "colorNoiseReduction": 25}}),
        ),
        // Every effect at once, for the floor of a busy photo.
        "neutral" => plain(
            Box::new(move |x, y| {
                let e = branch_distance(w, h, x, y) - half;
                let dark = coverage(e);
                let g = grass(x, y);
                (g.map(|c| (1.0 - dark) * c + dark * 0.02), true)
            }),
            json!({}),
        ),
        other => panic!("unknown case {other} (one of {CASES:?})"),
    }
}

fn encode_srgb(v: f64) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let e = if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    (e * 255.0).round() as u8
}

fn photo_png(photo: &Photo, w: usize, h: usize) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let (rgb, _) = photo(x as f64 + 0.5, y as f64 + 0.5);
            rgba.extend_from_slice(&[
                encode_srgb(rgb[0]),
                encode_srgb(rgb[1]),
                encode_srgb(rgb[2]),
                255,
            ]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

// MARK: - Measures

/// Linear sRGB (interleaved RGB).
struct Frame {
    w: usize,
    h: usize,
    lin: Vec<f32>,
}

fn linear(r: &Rendered) -> Frame {
    let table: Vec<f32> = (0..256)
        .map(|i| {
            let c = i as f64 / 255.0;
            (if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }) as f32
        })
        .collect();
    let lin = r
        .rgba
        .chunks_exact(4)
        .flat_map(|p| {
            [
                table[p[0] as usize],
                table[p[1] as usize],
                table[p[2] as usize],
            ]
        })
        .collect();
    Frame {
        w: r.width,
        h: r.height,
        lin,
    }
}

fn reduce(f: &Frame, w: usize, h: usize) -> Frame {
    let lin = resample(&f.lin, f.w, f.h, w, h, Filter::Lanczos3)
        .into_iter()
        .map(|v| v.max(0.0))
        .collect();
    Frame { w, h, lin }
}

fn lab(p: &[f32]) -> [f64; 3] {
    let (r, g, b) = (p[0] as f64, p[1] as f64, p[2] as f64);
    let x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    let f = |t: f64| {
        if t > 216.0 / 24389.0 {
            t.cbrt()
        } else {
            (24389.0 / 27.0 * t + 16.0) / 116.0
        }
    };
    let (fx, fy, fz) = (f(x / 0.95047), f(y), f(z / 1.08883));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn stats(mut v: Vec<f64>) -> Value {
    if v.is_empty() {
        return Value::Null;
    }
    v.sort_by(f64::total_cmp);
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    let p99 = v[((v.len() - 1) as f64 * 0.99).round() as usize];
    json!({"mean": round3(mean), "p99": round3(p99), "max": round3(v[v.len() - 1]), "n": v.len()})
}

/// ΔE00 of `b` against `a` (`all` and inside `roi`), and the mean chroma
/// of each inside `roi` (the residual fringe of a neutral photo).
fn compare(a: &Frame, b: &Frame, roi: &[bool]) -> Value {
    let (mut all, mut inside) = (Vec::with_capacity(roi.len()), Vec::new());
    let (mut ca, mut cb) = (0.0, 0.0);
    let mut worst: Vec<(f64, usize)> = Vec::new();
    for (i, &r) in roi.iter().enumerate() {
        let (la, lb) = (lab(&a.lin[i * 3..i * 3 + 3]), lab(&b.lin[i * 3..i * 3 + 3]));
        let d = delta_e00(la, lb);
        all.push(d);
        if r {
            inside.push(d);
            ca += la[1].hypot(la[2]);
            cb += lb[1].hypot(lb[2]);
            if worst.len() < 6 || d > worst[5].0 {
                worst.push((d, i));
                worst.sort_by(|x, y| y.0.total_cmp(&x.0));
                worst.truncate(6);
            }
        }
    }
    let n = inside.len().max(1) as f64;
    let worst: Vec<Value> = worst
        .iter()
        .map(|&(d, i)| {
            let (la, lb) = (lab(&a.lin[i * 3..i * 3 + 3]), lab(&b.lin[i * 3..i * 3 + 3]));
            json!({"x": i % a.w, "y": i / a.w, "de": round3(d),
                "screen": la.map(|v| (v * 10.0).round() / 10.0),
                "export": lb.map(|v| (v * 10.0).round() / 10.0)})
        })
        .collect();
    json!({
        "all": stats(all),
        "roi": stats(inside),
        "chroma": {"screen": round3(ca / n), "export": round3(cb / n)},
        "worst": worst,
    })
}

fn luma(f: &Frame, x: usize, y: usize) -> f64 {
    let p = &f.lin[(y * f.w + x) * 3..];
    0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64
}

/// The 10-90% width (in `f`'s pixels) of the step through full-size
/// `(row, column)` over `±half` full-size pixels, rows averaged over ±8.
fn edge_width(f: &Frame, full_w: f64, (row, column, half): (f64, f64, f64)) -> f64 {
    let k = f.w as f64 / full_w;
    let (y0, x0) = ((row * k) as usize, (column * k) as usize);
    let n = (half * k).ceil() as usize;
    let profile: Vec<f64> = (x0 - n..=x0 + n)
        .map(|x| (y0 - 8..=y0 + 8).map(|y| luma(f, x, y)).sum::<f64>() / 17.0)
        .collect();
    let (hi, lo) = (profile[0], profile[profile.len() - 1]);
    let crossing = |level: f64| {
        let target = lo + level * (hi - lo);
        profile
            .windows(2)
            .position(|p| p[0] >= target && p[1] < target)
            .map_or(f64::NAN, |i| {
                i as f64 + (profile[i] - target) / (profile[i] - profile[i + 1])
            })
    };
    round3(crossing(0.1) - crossing(0.9))
}

/// Mean absolute horizontal luma step inside a hole and in the ring of
/// 1.0..1.5 radii around it: the texture the fill keeps.
fn texture(f: &Frame, full_w: f64, (cx, cy, r): (f64, f64, f64)) -> Value {
    let k = f.w as f64 / full_w;
    let (mut sums, mut counts) = ([0.0f64; 2], [0usize; 2]);
    for y in 0..f.h {
        for x in 0..f.w - 1 {
            let d = ((x as f64 + 0.5) / k - cx).hypot((y as f64 + 0.5) / k - cy) / r;
            let i = if d < 0.8 {
                0
            } else if (1.0..1.5).contains(&d) {
                1
            } else {
                continue;
            };
            sums[i] += (luma(f, x + 1, y).sqrt() - luma(f, x, y).sqrt()).abs();
            counts[i] += 1;
        }
    }
    let (inside, ring) = (sums[0] / counts[0] as f64, sums[1] / counts[1] as f64);
    json!({"inside": round3(inside * 1000.0), "ring": round3(ring * 1000.0), "ratio": round3(inside / ring)})
}

fn sample(f: &Frame, x: f64, y: f64) -> [f64; 3] {
    let (x, y) = (x - 0.5, y - 0.5);
    let (x0, y0) = (x.floor(), y.floor());
    let (tx, ty) = (x - x0, y - y0);
    let at = |dx: f64, dy: f64, c: usize| {
        let xi = ((x0 + dx) as usize).min(f.w - 1);
        let yi = ((y0 + dy) as usize).min(f.h - 1);
        f.lin[(yi * f.w + xi) * 3 + c] as f64
    };
    [0, 1, 2].map(|c| {
        (1.0 - ty) * ((1.0 - tx) * at(0.0, 0.0, c) + tx * at(1.0, 0.0, c))
            + ty * ((1.0 - tx) * at(0.0, 1.0, c) + tx * at(1.0, 1.0, c))
    })
}

/// Linear luma (x 1000) and chroma across the edge, every screen pixel
/// from 6 inside to 10 outside.
fn profile(f: &Frame, full_w: f64, screen_w: f64, (p, n): ([f64; 2], [f64; 2])) -> Value {
    let k = f.w as f64 / full_w;
    let step = full_w / screen_w;
    let points: Vec<Value> = (-6..=10)
        .map(|t| {
            let d = t as f64 * step;
            let rgb = sample(f, (p[0] + d * n[0]) * k, (p[1] + d * n[1]) * k);
            let l = lab(&rgb.map(|v| v as f32));
            let y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
            json!([round3(y * 1000.0), round3(l[1].hypot(l[2]))])
        })
        .collect();
    Value::Array(points)
}

fn ms(t: Instant) -> f64 {
    (t.elapsed().as_secs_f64() * 1000.0).round()
}

fn render(
    png: &[u8],
    working: usize,
    case: &Case,
    settings: &DevelopSettings,
) -> (Rendered, f64, Value) {
    let mut session = Session::open_raster(png, working, Filter::Lanczos3).unwrap();
    if let Some((id, surface)) = &case.surface {
        session.set_mask_surface(id, surface).unwrap();
    }
    let t = Instant::now();
    let r = session.render(settings, 0, Quality::Final).unwrap();
    let t = ms(t);
    let chromatic = session.lens_stats().chromatic.map_or(
        Value::Null,
        |c| json!({"red": c.red, "blue": c.blue, "edges": c.edges}),
    );
    (r, t, chromatic)
}

fn run(name: &str, long: usize, full_only: bool, neutral_only: bool) {
    let (w, h) = (long, long * 2 / 3);
    let case = make_case(name, w as f64, h as f64);
    let png = photo_png(&case.photo, w, h);
    let effect = base_settings(&case.effect);
    let neutral = base_settings(&json!({}));
    if full_only {
        let s = if neutral_only { &neutral } else { &effect };
        let (full, t, _) = render(&png, 0, &case, s);
        println!(
            "{}",
            json!({"case": name, "long": long, "neutral": neutral_only, "full": [full.width, full.height], "ms": t})
        );
        return;
    }
    let mut out = json!({"case": name, "long": long});
    for (key, settings) in [("effect", &effect), ("neutral", &neutral)] {
        if key == "neutral" && name == "neutral" {
            continue;
        }
        let (screen, ts, cs) = render(&png, SCREEN, &case, settings);
        let (full, tf, cf) = render(&png, 0, &case, settings);
        let screen_f = linear(&screen);
        let full_f = linear(&full);
        let reduced = reduce(&full_f, screen.width, screen.height);
        let (kx, ky) = (
            w as f64 / screen.width as f64,
            h as f64 / screen.height as f64,
        );
        let roi: Vec<bool> = (0..screen.height)
            .flat_map(|y| (0..screen.width).map(move |x| (x, y)))
            .map(|(x, y)| (case.photo)((x as f64 + 0.5) * kx, (y as f64 + 0.5) * ky).1)
            .collect();
        let mut m = compare(&screen_f, &reduced, &roi);
        m["ms"] = json!({"screen": ts, "export": tf});
        if !cs.is_null() || !cf.is_null() {
            m["chromaticEstimate"] = json!({"screen": cs, "export": cf});
        }
        if let Some(edge) = case.profile {
            let sw = screen.width as f64;
            m["profile"] = json!({
                "screen": profile(&screen_f, w as f64, sw, edge),
                "exportReduced": profile(&reduced, w as f64, sw, edge),
            });
        }
        if let Some(edge) = case.edge {
            m["edgeWidth"] = json!({
                "screen": edge_width(&screen_f, w as f64, edge),
                "exportReduced": edge_width(&reduced, w as f64, edge),
                "exportFullPx": edge_width(&full_f, w as f64, edge),
            });
        }
        if let Some(hole) = case.hole {
            m["texture"] = json!({
                "screen": texture(&screen_f, w as f64, hole),
                "exportReduced": texture(&reduced, w as f64, hole),
            });
        }
        out["screen"] = json!([screen.width, screen.height]);
        out["full"] = json!([full.width, full.height]);
        out[key] = m;
    }
    println!("{out}");
}

const SHARP: SharpeningSettings = SharpeningSettings {
    amount: 80.0,
    radius: 1.0,
    detail: 25.0,
    masking: 0.0,
};

fn luma3(p: &[f32]) -> f32 {
    0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
}

fn sharpened(f: &Frame, whole_long_edge: usize) -> Frame {
    let mut lin = f.lin.clone();
    sharpen_linear_srgb(&mut lin, f.w, f.h, whole_long_edge, SHARP).unwrap();
    Frame {
        w: f.w,
        h: f.h,
        lin,
    }
}

/// The screen's change of luma (`sharp - plain`) enlarged to `full`'s size
/// (Lanczos 3) and added there, RGB scaled to the new luma.
fn enlarged_change(full: &Frame, plain: &Frame, sharp: &Frame) -> Frame {
    let delta: Vec<f32> = plain
        .lin
        .chunks_exact(3)
        .zip(sharp.lin.chunks_exact(3))
        .flat_map(|(p, q)| {
            let d = luma3(q) - luma3(p);
            [d, d, d]
        })
        .collect();
    let up = resample(&delta, plain.w, plain.h, full.w, full.h, Filter::Lanczos3);
    let lin = full
        .lin
        .chunks_exact(3)
        .zip(up.chunks_exact(3))
        .flat_map(|(p, d)| {
            let level = luma3(p);
            let target = (level + d[0]).max(0.0);
            if level >= 1e-4 {
                let r = target / level;
                [p[0] * r, p[1] * r, p[2] * r]
            } else {
                let add = target - level;
                [p[0] + add, p[1] + add, p[2] + add]
            }
        })
        .collect();
    Frame {
        w: full.w,
        h: full.h,
        lin,
    }
}

/// Mean absolute horizontal step of `sqrt(luma)` (x 1000): how crisp a
/// frame is at its own size.
fn crispness(f: &Frame) -> f64 {
    let mut sum = 0.0f64;
    for y in 0..f.h {
        for x in 0..f.w - 1 {
            sum += (luma(f, x + 1, y).sqrt() - luma(f, x, y).sqrt()).abs();
        }
    }
    round3(sum / ((f.w - 1) * f.h) as f64 * 1000.0)
}

/// The ways the export could sharpen (#133 item 5), on the photos without
/// sharpening rendered at both sizes:
///
/// - `now`: the full size sharpened as today (radii at a 1500 px long edge);
/// - `screenChange`: the screen's change of luma enlarged to the full size;
/// - `originalPixels`: radii in the original's pixels (Lightroom), at both
///   sizes (the screen at `1500 * 2560 / long`).
///
/// Each export, reduced to the screen's size, is compared with the screen
/// that goes with it; `screenMoves` is how far the original-pixel screen is
/// from today's, `crisp` the full size's crispness.
fn sharpen_options(long: usize) {
    let (w, h) = (long, long * 2 / 3);
    for name in ["sharpen", "sharpen-edges", "sharpen-texture"] {
        let case = make_case(name, w as f64, h as f64);
        let png = photo_png(&case.photo, w, h);
        let plain = base_settings(&json!({}));
        let effect = base_settings(&case.effect);
        let (screen_now, _, _) = render(&png, SCREEN, &case, &effect);
        let screen_now = linear(&screen_now);
        let (sp, _, _) = render(&png, SCREEN, &case, &plain);
        let sp = linear(&sp);
        let (fp, _, _) = render(&png, 0, &case, &plain);
        let fp = linear(&fp);
        let (sw, sh) = (sp.w, sp.h);
        let (kx, ky) = (w as f64 / sw as f64, h as f64 / sh as f64);
        let roi: Vec<bool> = (0..sh)
            .flat_map(|y| (0..sw).map(move |x| (x, y)))
            .map(|(x, y)| (case.photo)((x as f64 + 0.5) * kx, (y as f64 + 0.5) * ky).1)
            .collect();
        let roi_stats = |a: &Frame, b: &Frame| compare(a, b, &roi)["roi"].clone();
        let screen = sharpened(&sp, sw.max(sh));
        let now = sharpened(&fp, w);
        let change = enlarged_change(&fp, &sp, &screen);
        let original_screen = sharpened(&sp, 1500 * sw.max(sh) / w);
        let original = sharpened(&fp, 1500);
        let small = |f: &Frame| reduce(f, sw, sh);
        println!(
            "{}",
            json!({
                "case": name, "long": long,
                "sanity": roi_stats(&screen_now, &screen),
                "now": roi_stats(&screen, &small(&now)),
                "screenChange": roi_stats(&screen, &small(&change)),
                "originalPixels": roi_stats(&original_screen, &small(&original)),
                "screenMoves": roi_stats(&screen, &original_screen),
                "crisp": {
                    "plain": crispness(&fp), "now": crispness(&now),
                    "screenChange": crispness(&change), "originalPixels": crispness(&original),
                },
            })
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .map(|i| args[i + 1].clone())
    };
    let long: usize = value("--long").map_or(6000, |v| v.parse().unwrap());
    let which = value("--case").unwrap_or_else(|| "all".into());
    let full_only = args.iter().any(|a| a == "--full-only");
    let neutral_only = args.iter().any(|a| a == "--neutral");
    if args.iter().any(|a| a == "--sharpen-options") {
        sharpen_options(long);
        return;
    }
    let names: Vec<&str> = if which == "all" {
        CASES.to_vec()
    } else {
        which.split(',').collect()
    };
    for name in names {
        run(name, long, full_only, neutral_only);
    }
}
