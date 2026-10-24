//! Byte digests of every engine's output on synthetic inputs (#89): a
//! performance change that must not move pixels prints the same lines on
//! the builds before and after it (`diff` the two outputs).
//!
//!   cargo run --release -p niho-develop --example engine_digests > digests.txt
//!
//! Engines `niho-1`〜`niho-13` (and any newer one passed as arguments) ×
//! raster originals (two scenes), a raster working copy, a legacy unsigned
//! RAW working copy and a signed RAW working copy × settings (neutral, H/S,
//! relative white balance, crop, noise reduction, effects, presets' kinds of
//! edits) × a Session's Interactive, Final and reduced Interactive frames,
//! a drag of the white balance and its release, the one-shot render, color
//! sampling and "自動". Each line is `<case> <fnv1a64 of the RGBA | error>`.
//! Synthetic only: no photo is read.

use niho_develop::decode::{encode_signed_working_copy, encode_working_copy, LinearImage};
use niho_develop::look::{
    LOOK_NIHO_STANDARD_1, LOOK_NIHO_STANDARD_2, LOOK_NIHO_STANDARD_3, LOOK_NIHO_STANDARD_4,
    LOOK_NIHO_STANDARD_5,
};
use niho_develop::settings::DetailSettings;
use niho_develop::{encode, DevelopSettings, Filter, Quality, RenderOptions, Session};

const LEGACY_RAW_META: &str = r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"fixture","lookTableIncluded":true}"#;
const RASTER_META: &str = r#"{"kind":"raster","iccSha256":"sRGB"}"#;
const ENGINES: [&str; 12] = [
    "niho-1", "niho-2", "niho-3", "niho-4", "niho-5", "niho-6", "niho-7", "niho-8", "niho-10",
    "niho-11", "niho-12", "niho-13",
];

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// A dark room with a bright window, a saturated object, a gradient and
/// noise.
fn room(w: usize, h: usize, seed: u32) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(w * h * 4);
    let mut state = seed;
    for y in 0..h {
        for x in 0..w {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 9) as i32 - 4;
            let window = x * 3 > w * 2 && y * 5 < h * 2;
            let (ox, oy) = (w as i32 / 4, h as i32 * 2 / 3);
            let object = (x as i32 - ox).pow(2) + (y as i32 - oy).pow(2) < (w * h / 40) as i32;
            let (r, g, b) = if window {
                (235, 240, 250)
            } else if object {
                (170, 40, 30)
            } else {
                (
                    12 + (x * 120 / w) as i32,
                    10 + (y * 90 / h) as i32,
                    8 + ((x + y) * 60 / (w + h)) as i32,
                )
            };
            let c = |v: i32| (v + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

/// Saturated sky and foliage, portrait.
fn outdoor(w: usize, h: usize) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let t = y as f32 / h as f32;
            let (r, g, b) = if t < 0.45 {
                (40.0 + 80.0 * t, 110.0 + 120.0 * t, 230.0)
            } else if (x / 7 + y / 5) % 3 == 0 {
                (30.0, 150.0 - 60.0 * t, 40.0)
            } else {
                (90.0 + 60.0 * t, 70.0 + 50.0 * t, 30.0)
            };
            rgba.extend_from_slice(&[r as u8, g as u8, b as u8, 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

/// Linear ProPhoto with colors outside sRGB and values above 1.
fn prophoto(w: usize, h: usize) -> LinearImage {
    LinearImage {
        width: w,
        height: h,
        data: (0..w * h)
            .flat_map(|i| {
                let (x, y) = (
                    (i % w) as f32 / (w - 1) as f32,
                    (i / w) as f32 / (h - 1) as f32,
                );
                [
                    0.004 + 0.9 * x * x,
                    0.006 + 1.3 * x * (1.0 - 0.5 * y),
                    0.01 + 0.5 * y * y,
                ]
            })
            .collect(),
    }
}

fn base(engine: &str) -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.engine = engine.into();
    s.look = match engine {
        "niho-3" => LOOK_NIHO_STANDARD_2,
        "niho-4" => LOOK_NIHO_STANDARD_3,
        "niho-5" => LOOK_NIHO_STANDARD_4,
        "niho-7" | "niho-11" => LOOK_NIHO_STANDARD_5,
        _ => LOOK_NIHO_STANDARD_1,
    }
    .into();
    s
}

fn white(mut s: DevelopSettings, temperature: f64, tint: f64) -> DevelopSettings {
    let mut value = s.to_value();
    value["whiteBalance"] = serde_json::json!({"mode": "relative"});
    value["relativeTemperature"] = temperature.into();
    value["relativeTint"] = tint.into();
    s = DevelopSettings::from_json(&value.to_string()).unwrap();
    s
}

fn with_version(mut s: DevelopSettings) -> DevelopSettings {
    s.v = s.required_version();
    s
}

fn cases(engine: &str) -> Vec<(&'static str, DevelopSettings)> {
    let neutral = base(engine);
    let mut hs = base(engine);
    hs.exposure = 0.2;
    hs.highlights = -75.0;
    hs.shadows = 55.0;
    hs.blacks = 40.0;
    hs.vibrance = 10.0;
    let mut extreme = base(engine);
    extreme.exposure = -0.7;
    extreme.highlights = -100.0;
    extreme.shadows = 100.0;
    extreme.whites = -30.0;
    let mut look = base(engine);
    look.contrast = 25.0;
    look.clarity = 20.0;
    look.texture = 15.0;
    look.dehaze = 10.0;
    look.saturation = -15.0;
    look.vibrance = 25.0;
    look.highlights = -40.0;
    look.shadows = 30.0;
    look.parametric_shadows = 12.0;
    look.parametric_highlights = -8.0;
    let mut crop = hs.to_value();
    crop["v"] = 2.into();
    crop["geometry"] = serde_json::json!({"rotate":90,"angle":3.0,"crop":{"left":0.1,"top":0.15,"right":0.85,"bottom":0.9}});
    let crop = DevelopSettings::from_json(&crop.to_string()).unwrap();
    let mut noise = hs.clone();
    noise.detail = Some(DetailSettings {
        luminance_noise_reduction: 30.0,
        color_noise_reduction: Some(25.0),
        ..DetailSettings::default()
    });
    let noise = with_version(noise);
    let mut effects = hs.clone();
    effects.vignette.amount = -35.0;
    effects.grain.amount = 20.0;
    let effects = with_version(effects);
    let mut hsl = hs.to_value();
    hsl["hsl"] = serde_json::json!({"orange":{"hue":5,"saturation":-10,"luminance":20},"blue":{"hue":-8,"saturation":15,"luminance":-10}});
    let hsl = DevelopSettings::from_json(&hsl.to_string()).unwrap();
    vec![
        ("neutral", neutral.clone()),
        ("hs", hs.clone()),
        ("extreme", extreme.clone()),
        ("look", look.clone()),
        ("hsl", hsl.clone()),
        ("wb", white(neutral, 30.0, 20.0)),
        ("hs-wb", white(hs.clone(), -40.0, 0.0)),
        ("extreme-wb", white(extreme, 25.0, -15.0)),
        ("look-wb", white(look, 0.0, 30.0)),
        ("crop-wb", white(crop, 30.0, 0.0)),
        ("noise-wb", white(noise, 15.0, 10.0)),
        ("effects-wb", white(effects, -20.0, 5.0)),
        ("hsl-wb", white(hsl, 30.0, 20.0)),
    ]
}

fn digest(result: Result<Vec<u8>, String>) -> String {
    match result {
        Ok(bytes) => format!("{:016x}", fnv1a64(&bytes)),
        Err(error) => format!("error: {error}"),
    }
}

fn main() {
    let extra: Vec<String> = std::env::args().skip(1).collect();
    let engines: Vec<&str> = ENGINES
        .iter()
        .copied()
        .chain(extra.iter().map(String::as_str))
        .collect();
    let room_png = room(160, 120, 0x2f6b_4e1d);
    let outdoor_png = outdoor(90, 130);
    let image = prophoto(120, 90);
    let wc = encode_working_copy(&image);
    let (signed, encoding) = encode_signed_working_copy(&image).unwrap();
    let signed_meta = format!(
        r#"{{"kind":"raw","baselineEV":0,"asShotWhite":{{"x":0.3457,"y":0.3585}},"dcpSha256":"fixture","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    let sources: [(&str, &[u8], Option<&str>); 5] = [
        ("room", &room_png, None),
        ("outdoor", &outdoor_png, None),
        ("raster-wc", &wc, Some(RASTER_META)),
        ("legacy-raw", &wc, Some(LEGACY_RAW_META)),
        ("signed-raw", &signed, Some(&signed_meta)),
    ];
    for engine in &engines {
        for (source, bytes, meta) in sources {
            let open = || match meta {
                None => Session::open_raster(bytes, 0, Filter::Lanczos3),
                Some(meta) => Session::open_working_copy(bytes, meta, Filter::Lanczos3),
            };
            for (name, settings) in cases(engine) {
                let case = format!("{engine} {source} {name}");
                let mut session = match open() {
                    Ok(session) => session,
                    Err(error) => {
                        println!("{case} open error: {error}");
                        continue;
                    }
                };
                let mut frame = |label: &str, s: &DevelopSettings, size: usize, q: Quality| {
                    let r = session
                        .render(s, size, q)
                        .map(|f| f.rgba)
                        .map_err(|e| e.to_string());
                    println!("{case} {label} {}", digest(r));
                };
                frame("interactive", &settings, 0, Quality::Interactive);
                frame("final", &settings, 0, Quality::Final);
                frame("small", &settings, 64, Quality::Interactive);
                // A drag of the white balance (three ticks), then its release.
                let start = settings.relative_temperature;
                for tick in 1..=3 {
                    let s = white(
                        settings.clone(),
                        start + 6.0 * tick as f64,
                        settings.relative_tint,
                    );
                    frame(&format!("drag{tick}"), &s, 0, Quality::Interactive);
                }
                let released = white(settings.clone(), start + 18.0, settings.relative_tint);
                frame("release", &released, 0, Quality::Final);
                frame("back", &settings, 0, Quality::Final);
                let sample = session
                    .sample_color(&settings, 0, 0.3, 0.6)
                    .map(|c| c.map(f64::to_bits))
                    .map_err(|e| e.to_string());
                println!("{case} sample {sample:?}");
                let auto = session
                    .auto_settings(&settings)
                    .map(|s| s.to_json())
                    .map_err(|e| e.to_string());
                println!("{case} auto {}", digest(auto.map(String::into_bytes)));
                if meta.is_none() {
                    let one_shot = niho_develop::render(
                        bytes,
                        &settings.to_json(),
                        &RenderOptions {
                            max_dimension: 0,
                            ..Default::default()
                        },
                    )
                    .map(|f| f.rgba)
                    .map_err(|e| e.to_string());
                    println!("{case} one-shot {}", digest(one_shot));
                }
            }
        }
    }
}
