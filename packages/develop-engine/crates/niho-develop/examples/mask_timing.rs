//! Timings of the layered mask render (`docs/local-adjustments.md` "性能の目安と
//! 測り方", #66) on synthetic photos, as the editor drives a Session:
//!
//! `cargo run --release --example mask_timing [-- --dump <dir>] [--source raster|raw|all] [--trials 3] [--drag <px>]`
//! (`--drag` is the long edge of the Interactive frames, default 1280 = `UI`; the editor draws 640 while a mask is
//! active, `developInteractiveMaxDimension`.)
//!
//! For 0..=3 masks and three kinds of local delta (cube stages only; an
//! exposure that changes the master's input; the local pass's Texture /
//! Clarity / Highlights / Shadows) on a 2048 x 1365 JPEG-like raster
//! (`niho-10`) and a signed RAW working copy (`niho-11`):
//!
//! - `first`: the first frame (Final 1280) of a new Session;
//! - `dragFirst`: the first drag frame (Interactive 1280) moving one mask's
//!   slider (with no mask, Contrast);
//! - `dragMask`: the median of 6 further drag frames moving that slider;
//! - `dragGlobal`: the median of 6 drag frames moving Contrast by 1 (after
//!   the release; `dragGlobalFirst` is the first of them, which draws the
//!   layers: the drag's anchor, #92);
//! - `dragGlobalFast`: the mean of the next 6 drag frames moving Contrast by
//!   10 each (past the reuse bound of 25 every third frame, #92);
//! - `release`: the Final 1280 frame after the mask's drag;
//! - `full`: a Final frame at the working size in a new Session.
//!
//! `--dump <dir>` writes the synthetic inputs (`raster.png`, `raw.png`,
//! `raw.json`) for `tools/mask-wasm-bench.cjs`, which runs the same
//! scenarios in wasm.

use niho_develop::decode::encode_signed_working_copy;
use niho_develop::{encode, DevelopSettings, Filter, LinearImage, Quality, Session};
use serde_json::{json, Value};
use std::time::Instant;

const WIDTH: usize = 2048;
const HEIGHT: usize = 1365;
const UI: usize = 1280;
const DRAG_FRAMES: usize = 6;

fn raster() -> Vec<u8> {
    let mut rgba = Vec::with_capacity(WIDTH * HEIGHT * 4);
    let mut state = 0x2f6b_4e1du32;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 9) as i32 - 4;
            let sky = y < HEIGHT * 2 / 5;
            let object = (x as i32 - 1300).pow(2) + (y as i32 - 900).pow(2) < 200 * 200;
            let (r, g, b) = if sky {
                (140 + (x / 32) as i32, 180 + (y / 16) as i32, 245)
            } else if object {
                (190, 60 + (x / 64) as i32, 40)
            } else {
                (
                    30 + (x / 24) as i32,
                    40 + (y / 20) as i32,
                    25 + ((x + y) / 64) as i32,
                )
            };
            let c = |v: i32| (v + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
        }
    }
    encode::encode_png(&rgba, WIDTH, HEIGHT).unwrap()
}

fn raw() -> (Vec<u8>, String) {
    let mut data = Vec::with_capacity(WIDTH * HEIGHT * 3);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let t = x as f32 / WIDTH as f32;
            let u = y as f32 / HEIGHT as f32;
            let window = (WIDTH * 3 / 5..WIDTH * 9 / 10).contains(&x) && y < HEIGHT / 3;
            data.extend_from_slice(&if window {
                [2.2 + t, 2.3, 2.6]
            } else {
                [
                    0.01 + 0.5 * t * t,
                    0.03 + 0.4 * u,
                    0.06 + 0.3 * (1.0 - t) * u,
                ]
            });
        }
    }
    let image = LinearImage {
        width: WIDTH,
        height: HEIGHT,
        data,
    };
    let (png, encoding) = encode_signed_working_copy(&image).unwrap();
    let meta = format!(
        r#"{{"kind":"raw","baselineEV":-0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":0}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    (png, meta)
}

/// The global settings of a typical edit (both use their master).
fn global(source: &str) -> Value {
    match source {
        "raster" => json!({
            "v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null,
            "highlights": -30, "shadows": 20, "contrast": 10, "vibrance": 10
        }),
        _ => json!({
            "v": 5, "engine": "niho-11", "look": "niho-standard-5", "base": null,
            "exposure": -0.2, "highlights": -40, "shadows": 20, "contrast": 10
        }),
    }
}

/// `(name, the dragged key, its delta)`.
const DELTAS: [(&str, &str, f64); 3] = [
    ("cube", "saturation", 20.0),
    ("exposure", "exposure", -0.7),
    ("spatial", "clarity", 25.0),
];

fn adjust(kind: &str, key: &str, value: f64) -> Value {
    let mut a = json!({ key: value });
    if kind == "spatial" {
        a["texture"] = json!(20);
        a["shadows"] = json!(25);
        a["highlights"] = json!(-30);
    }
    if kind == "cube" {
        a["contrast"] = json!(15);
    }
    a
}

/// `count` masks; the first one's dragged key is `value + step` (the
/// others keep theirs).
fn masks(count: usize, kind: &str, key: &str, value: f64, step: f64) -> Value {
    let shapes = [
        json!({"kind": "linear", "zero": {"x": 0.5, "y": 0.55}, "full": {"x": 0.5, "y": 0.2}}),
        json!({"kind": "radial", "center": {"x": 0.63, "y": 0.66}, "radius": {"x": 0.15, "y": 0.22}, "angle": 10, "feather": 50}),
        json!({"kind": "radial", "invert": true, "center": {"x": 0.5, "y": 0.5}, "radius": {"x": 0.45, "y": 0.5}, "angle": 0, "feather": 80}),
    ];
    Value::Array(
        shapes
            .iter()
            .take(count)
            .enumerate()
            .map(|(i, shape)| {
                let mut m = shape.clone();
                m["id"] = json!(format!("m{i}"));
                let v = if i == 0 { value + step } else { value * 0.5 };
                m["adjust"] = adjust(kind, key, v);
                m
            })
            .collect(),
    )
}

fn settings(base: &Value, masks: Value, contrast: f64) -> DevelopSettings {
    let mut v = base.clone();
    v["contrast"] = json!(contrast);
    if !masks.as_array().unwrap().is_empty() {
        v["masks"] = masks;
    }
    DevelopSettings::from_value(&v).unwrap()
}

fn ms(t: Instant) -> f64 {
    (t.elapsed().as_secs_f64() * 1e4).round() / 10.0
}

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(f64::total_cmp);
    xs[xs.len() / 2]
}

/// The scenario's timings (ms): first, dragFirst, dragMask, dragGlobal,
/// release, full, dragGlobalFirst, dragGlobalFast.
fn scenario(
    open: &dyn Fn() -> Session,
    source: &str,
    count: usize,
    delta: (&str, &str, f64),
    drag: usize,
) -> [f64; 8] {
    let (kind, key, value) = delta;
    let base = global(source);
    let contrast = base["contrast"].as_f64().unwrap();
    let at = |step: f64, contrast: f64| {
        settings(
            &base,
            masks(count, kind, key, value, step * value.signum() * 0.02),
            contrast,
        )
    };
    let mut session = open();
    let t = Instant::now();
    session
        .render(&at(0.0, contrast), UI, Quality::Final)
        .unwrap();
    let first = ms(t);
    // The first drag frame: one mask's slider (no mask: Contrast).
    let moved = |i: usize| {
        if count == 0 {
            at(0.0, contrast + i as f64)
        } else {
            at(i as f64, contrast)
        }
    };
    let t = Instant::now();
    session
        .render(&moved(1), drag, Quality::Interactive)
        .unwrap();
    let drag_first = ms(t);
    let drag_mask = median(
        (2..2 + DRAG_FRAMES)
            .map(|i| {
                let s = moved(i);
                let t = Instant::now();
                session.render(&s, drag, Quality::Interactive).unwrap();
                ms(t)
            })
            .collect(),
    );
    let t = Instant::now();
    session
        .render(&moved(1 + DRAG_FRAMES), UI, Quality::Final)
        .unwrap();
    let release = ms(t);
    let global: Vec<f64> = (1..=DRAG_FRAMES)
        .map(|i| {
            let s = at(1.0 + DRAG_FRAMES as f64, contrast + i as f64);
            let t = Instant::now();
            session.render(&s, drag, Quality::Interactive).unwrap();
            ms(t)
        })
        .collect();
    let drag_global_first = global[0];
    let drag_global = median(global);
    let fast: Vec<f64> = (1..=DRAG_FRAMES)
        .map(|i| {
            let s = at(
                1.0 + DRAG_FRAMES as f64,
                contrast + DRAG_FRAMES as f64 + 10.0 * i as f64,
            );
            let t = Instant::now();
            session.render(&s, drag, Quality::Interactive).unwrap();
            ms(t)
        })
        .collect();
    let drag_global_fast = (fast.iter().sum::<f64>() / fast.len() as f64 * 10.0).round() / 10.0;
    drop(session);
    let mut fresh = open();
    let t = Instant::now();
    fresh.render(&at(0.0, contrast), 0, Quality::Final).unwrap();
    let full = ms(t);
    [
        first,
        drag_first,
        drag_mask,
        drag_global,
        release,
        full,
        drag_global_first,
        drag_global_fast,
    ]
}

/// The least of `trials` runs per timing (the machine's other load only
/// adds time).
fn measure(
    open: &dyn Fn() -> Session,
    source: &str,
    count: usize,
    delta: (&str, &str, f64),
    trials: usize,
    drag: usize,
) {
    let mut best = [f64::INFINITY; 8];
    for _ in 0..trials {
        let t = scenario(open, source, count, delta, drag);
        for (b, v) in best.iter_mut().zip(t) {
            *b = b.min(v);
        }
    }
    let [first, drag_first, drag_mask, drag_global, release, full, drag_global_first, drag_global_fast] =
        best;
    println!(
        "{}",
        json!({
            "source": source, "masks": count, "delta": delta.0, "trials": trials, "dragPx": drag,
            "firstMs": first, "dragFirstMs": drag_first, "dragMaskMs": drag_mask,
            "dragGlobalMs": drag_global, "dragGlobalFirstMs": drag_global_first,
            "dragGlobalFastMs": drag_global_fast, "releaseMs": release, "fullMs": full
        })
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
    };
    let png = raster();
    let (raw_png, raw_meta) = raw();
    if let Some(dir) = flag("--dump") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/raster.png"), &png).unwrap();
        std::fs::write(format!("{dir}/raw.png"), &raw_png).unwrap();
        std::fs::write(format!("{dir}/raw.json"), &raw_meta).unwrap();
        println!("wrote {dir}/raster.png, raw.png, raw.json");
        return;
    }
    let only = flag("--source").unwrap_or_else(|| "all".into());
    let trials: usize = flag("--trials").map_or(3, |t| t.parse().unwrap());
    let drag: usize = flag("--drag").map_or(UI, |t| t.parse().unwrap());
    let open_raster = || Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let open_raw = || Session::open_working_copy(&raw_png, &raw_meta, Filter::Lanczos3).unwrap();
    let sources: [(&str, &dyn Fn() -> Session); 2] = [("raster", &open_raster), ("raw", &open_raw)];
    for (source, open) in sources {
        if only != "all" && only != source {
            continue;
        }
        for delta in DELTAS {
            for count in 0..=3 {
                if count == 0 && delta.0 != "cube" {
                    continue;
                }
                measure(open, source, count, delta, trials, drag);
            }
        }
    }
}
