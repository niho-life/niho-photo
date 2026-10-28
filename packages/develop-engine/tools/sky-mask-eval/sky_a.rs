//! Candidate A of #128 in Rust, to time it as the product would run it (native and wasm).
//! A port of `sky_a.py::sky_probability` (same steps and constants; the outputs are compared
//! by `bench_a.py`). One file with no dependencies, so it builds without a Cargo manifest:
//!
//!   rustc --edition 2021 -C opt-level=3 -o sky_a_native sky_a.rs
//!   rustc --edition 2021 --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=3 -C panic=abort -o sky_a.wasm sky_a.rs
//!
//! Native: `sky_a_native <in.rgb> <w> <h> <ev100 | nan> <out.gray> [repeats]` (raw RGB8 in, raw grey8 out).
//! wasm: `alloc(len)`, `sky_a(rgb, w, h, ev100, out) -> flags` (bit 0: fallback seed, bit 1: no sky).

use std::collections::VecDeque;

const ANALYSIS: f64 = 384.0;

struct Plane {
    w: usize,
    h: usize,
    v: Vec<f32>,
}

impl Plane {
    fn new(w: usize, h: usize) -> Self {
        Plane { w, h, v: vec![0.0; w * h] }
    }
}

/// PIL's BILINEAR resample (triangle filter whose support grows with the downscale), on floats.
fn resample_axis(src: &[f32], len_in: usize, len_out: usize, stride: usize, count: usize, outer: usize) -> Vec<f32> {
    // `src` holds `outer` lines along the axis; each line has `len_in` samples `stride` apart,
    // and `count` interleaved channels/columns. Output keeps the same layout with `len_out`.
    let scale = len_in as f64 / len_out as f64;
    let filterscale = scale.max(1.0);
    let support = filterscale;
    let mut taps: Vec<(usize, Vec<f64>)> = Vec::with_capacity(len_out);
    for xx in 0..len_out {
        let center = (xx as f64 + 0.5) * scale;
        let ss = 1.0 / filterscale;
        let xmin = ((center - support + 0.5) as i64).max(0) as usize;
        let xmax = ((center + support + 0.5) as i64).min(len_in as i64) as usize - xmin;
        let mut ws: Vec<f64> = (0..xmax)
            .map(|x| {
                let t = ((x + xmin) as f64 - center + 0.5) * ss;
                if t.abs() < 1.0 { 1.0 - t.abs() } else { 0.0 }
            })
            .collect();
        let total: f64 = ws.iter().sum();
        if total != 0.0 {
            ws.iter_mut().for_each(|w| *w /= total);
        }
        taps.push((xmin, ws));
    }
    let along_rows = stride == 1;
    let mut out = vec![0.0f32; outer * len_out * count];
    for o in 0..outer {
        for c in 0..count {
            for (xx, (xmin, ws)) in taps.iter().enumerate() {
                let mut acc = 0.0f64;
                for (k, w) in ws.iter().enumerate() {
                    let i = if along_rows {
                        o * len_in * count + (xmin + k) * count + c
                    } else {
                        (xmin + k) * stride + o * count + c
                    };
                    acc += src[i] as f64 * w;
                }
                let j = if along_rows { o * len_out * count + xx * count + c } else { xx * count * outer + o * count + c };
                out[j] = acc as f32;
            }
        }
    }
    out
}

/// Resize an interleaved image of `ch` channels (horizontal pass, then vertical, like PIL).
fn resize(src: &[f32], w: usize, h: usize, ch: usize, ow: usize, oh: usize) -> Vec<f32> {
    let horiz = if ow != w { resample_axis(src, w, ow, 1, ch, h) } else { src.to_vec() };
    if oh != h {
        // Lines run down the columns: sample k of column o sits at k * (ow * ch) + o * ch.
        resample_axis(&horiz, h, oh, ow * ch, ch, ow)
    } else {
        horiz
    }
}

fn srgb_to_lab(rgb: &[f32]) -> Vec<[f32; 3]> {
    rgb.chunks_exact(3)
        .map(|c| {
            let lin = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
            let (r, g, b) = (lin(c[0]), lin(c[1]), lin(c[2]));
            let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
            let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
            let f = |t: f32| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
            let (fx, fy, fz) = (f(x), f(y), f(z));
            [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
        })
        .collect()
}

/// Mean over a (2r+1)^2 window, indices clamped to the edge (separable running sums).
fn boxf(p: &Plane, r: usize) -> Plane {
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
            s += tmp[clamp(y as isize + ri + 1, h) * w + x] - tmp[clamp(y as isize - ri, h) * w + x];
        }
    }
    out
}

fn guided_filter(guide: &Plane, src: &Plane, r: usize, eps: f32) -> Plane {
    let mul = |a: &Plane, b: &Plane| Plane { w: a.w, h: a.h, v: a.v.iter().zip(&b.v).map(|(x, y)| x * y).collect() };
    let mean_i = boxf(guide, r);
    let mean_p = boxf(src, r);
    let corr_ip = boxf(&mul(guide, src), r);
    let corr_ii = boxf(&mul(guide, guide), r);
    let n = guide.v.len();
    let mut a = Plane::new(guide.w, guide.h);
    let mut b = Plane::new(guide.w, guide.h);
    for i in 0..n {
        let cov = corr_ip.v[i] - mean_i.v[i] * mean_p.v[i];
        let var = corr_ii.v[i] - mean_i.v[i] * mean_i.v[i];
        a.v[i] = cov / (var + eps);
        b.v[i] = mean_p.v[i] - a.v[i] * mean_i.v[i];
    }
    let (ma, mb) = (boxf(&a, r), boxf(&b, r));
    Plane { w: guide.w, h: guide.h, v: (0..n).map(|i| ma.v[i] * guide.v[i] + mb.v[i]).collect() }
}

/// numpy's default (linear) percentile.
fn percentile(v: &[f32], q: f64) -> f64 {
    let mut s: Vec<f32> = v.to_vec();
    let pos = q / 100.0 * (s.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = (lo + 1).min(s.len() - 1);
    let (_, &mut a, rest) = s.select_nth_unstable_by(lo, |x, y| x.total_cmp(y));
    let b = if hi == lo { a } else { rest.iter().copied().fold(f32::INFINITY, f32::min) };
    a as f64 + (b as f64 - a as f64) * (pos - lo as f64)
}

fn bfs(seed: &[bool], allowed: &[bool], w: usize, h: usize) -> Vec<bool> {
    let mut seen: Vec<bool> = seed.iter().zip(allowed).map(|(s, a)| *s && *a).collect();
    let mut q: VecDeque<usize> = (0..w * h).filter(|&i| seen[i]).collect();
    while let Some(i) = q.pop_front() {
        let (y, x) = (i / w, i % w);
        let mut visit = |j: usize| {
            if allowed[j] && !seen[j] {
                seen[j] = true;
                q.push_back(j);
            }
        };
        if y > 0 { visit(i - w); }
        if y + 1 < h { visit(i + w); }
        if x > 0 { visit(i - 1); }
        if x + 1 < w { visit(i + 1); }
    }
    seen
}

fn design(x: f64, y: f64) -> [f64; 5] {
    [1.0, x, y, x * y, y * y]
}

/// Least squares of 5 coefficients per channel (normal equations, Gaussian elimination).
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
        let piv = (col..5).max_by(|&a, &b| m[a][col].abs().total_cmp(&m[b][col].abs())).unwrap();
        m.swap(col, piv);
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
            coef[i][c] = if m[i][i].abs() < 1e-12 { 0.0 } else { m[i][5 + c] / m[i][i] };
        }
    }
    coef
}

fn field(coef: &[[f64; 3]; 5], x: f64, y: f64) -> [f64; 3] {
    let d = design(x, y);
    let mut out = [0.0; 3];
    for c in 0..3 {
        out[c] = (0..5).map(|i| d[i] * coef[i][c]).sum();
    }
    out
}

fn dist(lab: &[f32; 3], pred: &[f64; 3]) -> f32 {
    let d = |k: usize| lab[k] as f64 - pred[k];
    (0.5 * d(0) * d(0) + d(1) * d(1) + d(2) * d(2)).sqrt() as f32
}

/// Sky probability at the input size, 0..1. Returns flags (bit 0 fallback seed, bit 1 no sky).
pub fn sky_probability(rgb8: &[u8], w0: usize, h0: usize, ev100: Option<f64>, out: &mut [f32]) -> u32 {
    let scale = ANALYSIS / w0.max(h0) as f64;
    let aw = ((w0 as f64 * scale).round_ties_even() as usize).max(1);
    let ah = ((h0 as f64 * scale).round_ties_even() as usize).max(1);
    let full: Vec<f32> = rgb8.iter().map(|&v| v as f32 / 255.0).collect();
    let small = resize(&full, w0, h0, 3, aw, ah);
    let lab = srgb_to_lab(&small);
    let n = aw * ah;
    let lum: Vec<f32> = lab.iter().map(|l| l[0] / 100.0).collect();
    let lin_y: Vec<f32> = lum.iter().map(|&l| if l > 0.08 { ((l + 0.16) / 1.16).powi(3) } else { l / 9.033 }).collect();

    // Texture: mean gradient magnitude over a small window (np.gradient: central inside, one-sided at the edges).
    let mut grad = Plane::new(aw, ah);
    for y in 0..ah {
        for x in 0..aw {
            let at = |yy: usize, xx: usize| lum[yy * aw + xx];
            let gy = if ah < 2 { 0.0 } else if y == 0 { at(1, x) - at(0, x) } else if y == ah - 1 { at(y, x) - at(y - 1, x) } else { (at(y + 1, x) - at(y - 1, x)) / 2.0 };
            let gx = if aw < 2 { 0.0 } else if x == 0 { at(y, 1) - at(y, 0) } else if x == aw - 1 { at(y, x) - at(y, x - 1) } else { (at(y, x + 1) - at(y, x - 1)) / 2.0 };
            grad.v[y * aw + x] = (gx * gx + gy * gy).sqrt();
        }
    }
    let texture = boxf(&grad, 2).v;
    let tex_ref = percentile(&texture, 60.0) + 1e-4;
    let p70 = percentile(&lum, 70.0);
    let p75 = percentile(&lum, 75.0);
    let p80 = percentile(&lum, 80.0);
    let yn = |i: usize| (i / aw) as f64 / (ah.max(2) - 1) as f64;
    let xn = |i: usize| (i % aw) as f64 / (aw.max(2) - 1) as f64;

    let mut smooth = vec![false; n];
    let mut soft = vec![false; n];
    let mut bright = vec![false; n];
    let mut blue = vec![false; n];
    let mut neutral_clipped = vec![false; n];
    let mut candidate = vec![false; n];
    let mut cloud = vec![false; n];
    let mut chroma = vec![0.0f32; n];
    for i in 0..n {
        let [_, a, b] = lab[i];
        let c = a.hypot(b);
        chroma[i] = c;
        let hue = (b as f64).atan2(a as f64).to_degrees().rem_euclid(360.0);
        let t = texture[i] as f64;
        smooth[i] = t < 0.35 * tex_ref + 0.004;
        soft[i] = t < 2.0 * tex_ref + 0.01;
        blue[i] = hue > 190.0 && hue < 300.0 && c > 8.0;
        let neutral = c < 12.0;
        let l = lum[i] as f64;
        let warm = (hue < 90.0 || hue > 300.0) && c > 12.0 && l > 0.45;
        let clipped = lin_y[i] > 0.9;
        bright[i] = match ev100 {
            Some(ev) => ev + ((lin_y[i].max(1e-4) / 0.18) as f64).log2() >= 12.0 || clipped,
            None => l > 0.6f64.max(p75),
        };
        let bright_neutral = neutral && bright[i] && l > 0.6f64.max(p70);
        let colour_ok = (blue[i] && l > 0.35) || bright_neutral || (warm && bright[i]);
        candidate[i] = smooth[i] && colour_ok && bright[i] && yn(i) < 0.75;
        neutral_clipped[i] = neutral && clipped;
        cloud[i] = bright[i] && soft[i] && c < 7.0 && l > 0.72f64.max(p80);
    }
    let top: Vec<bool> = (0..n).map(|i| i < aw).collect();
    let mut seed = bfs(&top, &candidate, aw, ah);
    let mut flags = 0;
    if (seed.iter().filter(|&&s| s).count() as f64) < 0.01 * n as f64 {
        flags |= 1;
        seed = (0..n).map(|i| smooth[i] && bright[i] && (blue[i] || neutral_clipped[i]) && yn(i) < 0.5).collect();
        if (seed.iter().filter(|&&s| s).count() as f64) < 0.005 * n as f64 {
            out.iter_mut().for_each(|v| *v = 0.0);
            return flags | 2;
        }
    }

    // Sky colour field fitted on the seed (no extrapolation below / above it).
    let seeds: Vec<usize> = (0..n).filter(|&i| seed[i]).collect();
    let y_lo = seeds.iter().map(|&i| yn(i)).fold(f64::INFINITY, f64::min);
    let y_hi = seeds.iter().map(|&i| yn(i)).fold(f64::NEG_INFINITY, f64::max);
    let rows: Vec<([f64; 5], [f32; 3])> = seeds.iter().map(|&i| (design(xn(i), yn(i)), lab[i])).collect();
    let coef = fit(&rows);
    let d: Vec<f32> = (0..n).map(|i| dist(&lab[i], &field(&coef, xn(i), yn(i).clamp(y_lo, y_hi)))).collect();
    let seed_d: Vec<f32> = seeds.iter().map(|&i| d[i]).collect();
    let spread = (percentile(&seed_d, 90.0) + 1.5).min(10.0);

    let allowed: Vec<bool> = (0..n)
        .map(|i| bright[i] && ((d[i] as f64) < 2.2 * spread && (texture[i] as f64) < 0.6 * tex_ref + 0.006 || cloud[i]))
        .collect();
    let region = bfs(&seed, &allowed, aw, ah);
    let lowest = (0..n).rev().find(|&i| region[i]).map(|i| yn(i) + 0.05).unwrap_or(0.0);
    let region_f = Plane {
        w: aw,
        h: ah,
        v: (0..n)
            .map(|i| {
                let isolated = (d[i] as f64) < 0.8 * spread && bright[i] && !region[i] && yn(i) <= lowest;
                if region[i] || isolated { 1.0 } else { 0.0 }
            })
            .collect(),
    };

    // Output size: per-pixel field distance and the upsampled region.
    let big_lab = srgb_to_lab(&full);
    let region_up = resize(&region_f.v, aw, ah, 1, w0, h0);
    let mut p = Plane::new(w0, h0);
    let mut guide = Plane::new(w0, h0);
    for i in 0..w0 * h0 {
        let x = (i % w0) as f64 / (w0.max(2) - 1) as f64;
        let y = ((i / w0) as f64 / (h0.max(2) - 1) as f64).clamp(y_lo, y_hi);
        let bd = dist(&big_lab[i], &field(&coef, x, y)) as f64;
        let colour_p = ((2.0 * spread - bd) / (1.5 * spread)).clamp(0.0, 1.0) as f32;
        let r = region_up[i];
        p.v[i] = if r > 0.02 && r < 0.98 { 0.5 * r + 0.5 * colour_p } else { r };
        guide.v[i] = big_lab[i][0] / 100.0;
    }
    let r = ((w0.max(h0) as f64 / 256.0).round_ties_even() as usize).max(2);
    let g = guided_filter(&guide, &p, r, 1e-3);
    for (o, v) in out.iter_mut().zip(g.v) {
        *o = v.clamp(0.0, 1.0);
    }
    flags
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// wasm entry: RGB8 in, grey8 (rounded, half to even like numpy) out.
#[no_mangle]
pub extern "C" fn sky_a(rgb: *const u8, w: usize, h: usize, ev100: f64, out: *mut u8) -> u32 {
    let rgb = unsafe { std::slice::from_raw_parts(rgb, w * h * 3) };
    let out = unsafe { std::slice::from_raw_parts_mut(out, w * h) };
    let mut prob = vec![0.0f32; w * h];
    let flags = sky_probability(rgb, w, h, if ev100.is_nan() { None } else { Some(ev100) }, &mut prob);
    for (o, p) in out.iter_mut().zip(prob) {
        *o = (p * 255.0).round_ties_even() as u8;
    }
    flags
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 6 {
        eprintln!("usage: sky_a_native <in.rgb> <w> <h> <ev100|nan> <out.gray> [repeats]");
        std::process::exit(2);
    }
    let rgb = std::fs::read(&args[1]).expect("read input");
    let (w, h): (usize, usize) = (args[2].parse().unwrap(), args[3].parse().unwrap());
    let ev: f64 = args[4].parse().unwrap_or(f64::NAN);
    let repeats: usize = args.get(6).map(|s| s.parse().unwrap()).unwrap_or(1);
    let mut out = vec![0u8; w * h];
    let mut best = f64::INFINITY;
    let mut flags = 0;
    for _ in 0..repeats {
        let t = std::time::Instant::now();
        flags = sky_a(rgb.as_ptr(), w, h, ev, out.as_mut_ptr());
        best = best.min(t.elapsed().as_secs_f64());
    }
    std::fs::write(&args[5], &out).expect("write output");
    println!("{{\"seconds\": {best}, \"flags\": {flags}}}");
}
