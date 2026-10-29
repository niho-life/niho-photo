//! Timings of the editor's released frames on synthetic photos (#150), as the
//! editor drives a Session: per photo and engine, the first Final 1280 of a
//! new Session, Exposure +0.3, the bundled presets bluesky2 / pastel /
//! colorful on it, and back to pastel. With `--features threads` the work
//! runs on rayon (`RAYON_NUM_THREADS` threads). Each frame's RGBA SHA-256 is
//! printed, so runs on 1 and 8 threads (and before / after a change) can be
//! compared.
//!
//! `cargo run --release -p niho-develop --example stage_timing [--features threads] -- [--photo <name>|all] [--trials 3] [--loop <n>] [--dump <dir>]`
//!
//! The photos (2560 x 1707, the working copies' long edge): `raster` (a PNG
//! original), `rasterCopy` (a raster working copy), `legacy` (an unsigned
//! RAW working copy) on `niho-14`, and `signed` (a signed RAW working copy)
//! on `niho-11`. One JSON line per photo: the least of `trials` runs per
//! step (a new Session each run; the machine's other load only adds time).
//! `--loop <n>` runs the scenario `n` more times without printing (for
//! `sample`). `--dump <dir>` writes the inputs and every step's settings for
//! `tools/stage-wasm-bench.mjs`, which runs the same steps in wasm.

use niho_develop::decode::{encode_signed_working_copy, encode_working_copy};
use niho_develop::{encode, xmp, DevelopSettings, Filter, LinearImage, Quality, Session};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Instant;

const WIDTH: usize = 2560;
const HEIGHT: usize = 1707;
const UI: usize = 1280;
const PRESETS: [&str; 3] = ["niho-bluesky2", "niho-pastel", "niho-colorful"];

/// The photos: `(name, engine, look)`.
const PHOTOS: [(&str, &str, &str); 4] = [
    ("raster", "niho-14", "niho-standard-1"),
    ("rasterCopy", "niho-14", "niho-standard-1"),
    ("legacy", "niho-14", "niho-standard-1"),
    ("signed", "niho-11", "niho-standard-5"),
];

const RASTER_META: &str = r#"{"kind":"raster","iccSha256":"sRGB"}"#;
const LEGACY_RAW_META: &str = r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"fixture","lookTableIncluded":true}"#;

/// The next value of a xorshift noise in `-4..=4`.
fn noise(state: &mut u32) -> i32 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    (*state % 9) as i32 - 4
}

/// A sky over a dark field with a saturated object and noise (8-bit sRGB).
fn raster() -> Vec<u8> {
    let mut rgba = Vec::with_capacity(WIDTH * HEIGHT * 4);
    let mut state = 0x2f6b_4e1du32;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let n = noise(&mut state);
            let sky = y < HEIGHT * 2 / 5;
            let object = (x as i32 - 1600).pow(2) + (y as i32 - 1100).pow(2) < 250 * 250;
            let (r, g, b) = if sky {
                (140 + (x / 40) as i32, 180 + (y / 20) as i32, 245)
            } else if object {
                (190, 60 + (x / 80) as i32, 40)
            } else {
                (
                    30 + (x / 30) as i32,
                    40 + (y / 25) as i32,
                    25 + ((x + y) / 80) as i32,
                )
            };
            let c = |v: i32| (v + n).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
        }
    }
    encode::encode_png(&rgba, WIDTH, HEIGHT).unwrap()
}

/// Linear ProPhoto with a clipped window, a saturated patch, gradients and
/// noise.
fn linear() -> LinearImage {
    let mut data = Vec::with_capacity(WIDTH * HEIGHT * 3);
    let mut state = 0x9e37_79b9u32;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let n = noise(&mut state) as f32 * 0.002;
            let t = x as f32 / WIDTH as f32;
            let u = y as f32 / HEIGHT as f32;
            let window = (WIDTH * 3 / 5..WIDTH * 9 / 10).contains(&x) && y < HEIGHT / 3;
            let patch = (x as i32 - 700).pow(2) + (y as i32 - 1200).pow(2) < 180 * 180;
            data.extend_from_slice(&if window {
                [2.2 + t, 2.3, 2.6]
            } else if patch {
                [0.42 + n, 0.05, 0.03 - n]
            } else {
                [
                    0.01 + 0.5 * t * t + n,
                    0.03 + 0.4 * u - n,
                    0.06 + 0.3 * (1.0 - t) * u + n,
                ]
            });
        }
    }
    LinearImage {
        width: WIDTH,
        height: HEIGHT,
        data,
    }
}

/// The photo's bytes and working copy metadata (`None`: a raster original).
fn photo(name: &str) -> (Vec<u8>, Option<String>) {
    let unsigned = || {
        let mut image = linear();
        for value in &mut image.data {
            *value = value.clamp(0.0, 1.0);
        }
        encode_working_copy(&image)
    };
    match name {
        "raster" => (raster(), None),
        "rasterCopy" => (unsigned(), Some(RASTER_META.into())),
        "legacy" => (unsigned(), Some(LEGACY_RAW_META.into())),
        _ => {
            let (png, encoding) = encode_signed_working_copy(&linear()).unwrap();
            let meta = format!(
                r#"{{"kind":"raw","baselineEV":-0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":0}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
                encoding.ceiling()
            );
            (png, Some(meta))
        }
    }
}

fn open(png: &[u8], meta: Option<&str>) -> Session {
    match meta {
        None => Session::open_raster(png, 0, Filter::Lanczos3).unwrap(),
        Some(meta) => Session::open_working_copy(png, meta, Filter::Lanczos3).unwrap(),
    }
}

/// The steps' settings: `(label, settings)`.
fn steps(session: &Session, engine: &str, look: &str) -> Vec<(String, DevelopSettings)> {
    let mut base = DevelopSettings::new_edit();
    base.engine = engine.into();
    base.look = look.into();
    let mut exposed = base.clone();
    exposed.exposure = 0.3;
    let as_shot = session.as_shot_white();
    let preset = |id: &str| {
        xmp::apply_preset(xmp::builtin_preset(id).unwrap().xmp, &exposed, 1.0, as_shot)
            .unwrap()
            .settings
    };
    let mut out = vec![
        ("first".to_string(), base),
        ("exposure".into(), exposed.clone()),
    ];
    for id in PRESETS {
        out.push((id.trim_start_matches("niho-").into(), preset(id)));
    }
    out.push(("pastelAgain".into(), preset("niho-pastel")));
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// One run of the steps on a new Session: `(label, ms, sha256)`.
fn scenario(
    png: &[u8],
    meta: Option<&str>,
    engine: &str,
    look: &str,
) -> Vec<(String, f64, String)> {
    let mut session = open(png, meta);
    steps(&session, engine, look)
        .into_iter()
        .map(|(label, settings)| {
            let t = Instant::now();
            let frame = session.render(&settings, UI, Quality::Final).unwrap();
            let ms = (t.elapsed().as_secs_f64() * 1e4).round() / 10.0;
            (label, ms, hex(&Sha256::digest(&frame.rgba)))
        })
        .collect()
}

#[cfg(feature = "threads")]
fn threads() -> usize {
    rayon::current_num_threads()
}

#[cfg(not(feature = "threads"))]
fn threads() -> usize {
    1
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
    };
    let only = flag("--photo").unwrap_or_else(|| "all".into());
    let trials: usize = flag("--trials").map_or(3, |t| t.parse().unwrap());
    let loops: usize = flag("--loop").map_or(0, |t| t.parse().unwrap());
    let dump = flag("--dump");
    for (name, engine, look) in PHOTOS {
        if only != "all" && only != name {
            continue;
        }
        let (png, meta) = photo(name);
        if let Some(dir) = &dump {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(format!("{dir}/{name}.png"), &png).unwrap();
            let session = open(&png, meta.as_deref());
            let steps: Vec<Value> = steps(&session, engine, look)
                .into_iter()
                .map(|(label, settings)| json!([label, settings.to_json()]))
                .collect();
            let input = json!({ "meta": meta, "steps": steps });
            std::fs::write(format!("{dir}/{name}.json"), input.to_string()).unwrap();
            println!("wrote {dir}/{name}.png, {name}.json");
            continue;
        }
        let mut best: Vec<(String, f64, String)> = Vec::new();
        for _ in 0..trials.max(1) {
            let run = scenario(&png, meta.as_deref(), engine, look);
            if best.is_empty() {
                best = run;
                continue;
            }
            for (b, (label, ms, sha)) in best.iter_mut().zip(run) {
                assert_eq!((&b.0, &b.2), (&label, &sha), "the same bytes every run");
                b.1 = b.1.min(ms);
            }
        }
        for _ in 0..loops {
            scenario(&png, meta.as_deref(), engine, look);
        }
        let ms: serde_json::Map<String, Value> = best
            .iter()
            .map(|(l, ms, _)| (l.clone(), json!(ms)))
            .collect();
        let sha: serde_json::Map<String, Value> = best
            .iter()
            .map(|(l, _, sha)| (l.clone(), json!(&sha[..16])))
            .collect();
        println!(
            "{}",
            json!({
                "photo": name, "engine": engine, "threads": threads(), "trials": trials,
                "ms": ms, "sha256": sha
            })
        );
    }
}
