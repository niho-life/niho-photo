//! The frame does not depend on how the work is split (#148). Every engine
//! renders the synthetic photos it reads (a JPEG / PNG original, a raster
//! working copy, a legacy and a signed RAW working copy), with its look and
//! representative settings (exposure, the busy global sliders, color
//! noise reduction, the bundled presets, masks under a crop), released and
//! dragged; the SHA-256 of each frame's RGBA goes into one digest per photo
//! and engine. The digests are pinned and must be the same natively, natively
//! with the `threads` feature on 1 and 8 threads, and in browser wasm.
//!
//! A pixel change (a new engine) updates the pins; a split that changes a
//! single byte fails here.
//!
//! The stages split later (#150) that these photos do not reach have their
//! own photos and pinned lines ([`STAGE_PHOTOS`]), so the lines above stay
//! as they were.

use niho_develop::decode::{encode_signed_working_copy, encode_working_copy, LinearImage};
use niho_develop::{encode, parse_settings, xmp, DevelopSettings, Filter, Quality, Session};
use sha2::{Digest, Sha256};

/// The photos and the engines that read them (every engine at least once;
/// the others refuse the photo): a JPEG / PNG original, a raster working
/// copy, a legacy (unsigned) and a signed RAW working copy.
const PHOTOS: [(&str, &[&str]); 4] = [
    (
        "raster",
        &[
            "niho-1", "niho-2", "niho-6", "niho-8", "niho-10", "niho-12", "niho-13", "niho-14",
        ],
    ),
    ("rasterCopy", &["niho-6", "niho-10", "niho-14"]),
    ("legacy", &["niho-1", "niho-14"]),
    (
        "signed",
        &["niho-3", "niho-4", "niho-5", "niho-7", "niho-11"],
    ),
];

/// A sky over a dark field with a saturated object and noise (8-bit sRGB).
fn raster() -> Vec<u8> {
    let (w, h) = (160usize, 120usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    let mut state = 0x5bd1_e995u32;
    for y in 0..h {
        for x in 0..w {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 9) as i32 - 4;
            let sky = y < 45;
            let object = (x as i32 - 100).pow(2) + (y as i32 - 80).pow(2) < 300;
            let (r, g, b) = if sky {
                (150 + x as i32 / 4, 190 + y as i32, 245)
            } else if object {
                (180, 50, 40)
            } else {
                (30 + x as i32 / 6, 40 + y as i32 / 8, 20)
            };
            let c = |v: i32| (v + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

/// Linear ProPhoto with clipped highlights, a saturated patch and shadows.
fn linear() -> LinearImage {
    let (width, height) = (160usize, 120usize);
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            let pixel = if (60..120).contains(&x) && (10..50).contains(&y) {
                if x < 90 {
                    [1.25, 1.25, 1.25]
                } else {
                    [2.5, 2.4, 2.2]
                }
            } else if (x as i32 - 40).pow(2) + (y as i32 - 85).pow(2) < 250 {
                [0.42, 0.05, 0.03]
            } else {
                [
                    -0.02 + x as f32 / 600.0,
                    0.03 + y as f32 / 700.0,
                    0.02 + (x + y) as f32 / 1500.0,
                ]
            };
            data.extend_from_slice(&pixel);
        }
    }
    LinearImage {
        width,
        height,
        data,
    }
}

/// [`linear`] as a signed RAW working copy and its metadata.
fn signed_raw() -> (Vec<u8>, String) {
    signed_raw_of("panasonic-dc-s5")
}

/// [`signed_raw`] with the calibration of `camera`.
fn signed_raw_of(camera: &str) -> (Vec<u8>, String) {
    let (png, encoding) = encode_signed_working_copy(&linear()).unwrap();
    let meta = format!(
        r#"{{"kind":"raw","baselineEV":-0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":0}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-{camera}-apple-v4","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    (png, meta)
}

/// [`linear`] clipped to `0..=1` (the unsigned working copies).
fn unsigned_linear() -> LinearImage {
    let mut image = linear();
    for value in &mut image.data {
        *value = value.clamp(0.0, 1.0);
    }
    image
}

const LEGACY_RAW_META: &str = r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"fixture","lookTableIncluded":true}"#;
const RASTER_META: &str = r#"{"kind":"raster","iccSha256":"sRGB"}"#;

/// The look an engine requires (`engineLookMismatch`): the RAW engines have
/// their own; the others take the neutral settings' look or niho-standard-1.
fn look(engine: &str) -> &'static str {
    match engine {
        "niho-1" | "niho-2" => "niho-interim-1",
        "niho-3" => "niho-standard-2",
        "niho-4" => "niho-standard-3",
        "niho-5" => "niho-standard-4",
        "niho-7" | "niho-11" => "niho-standard-5",
        _ => "niho-standard-1",
    }
}

const MASKED: &str = r#"{"v":5,"engine":"ENGINE","look":"LOOK","base":null,"shadows":25,"vibrance":10,
"geometry":{"rotate":90,"angle":3.5,"crop":{"left":0.05,"top":0.08,"right":0.93,"bottom":0.95}},
"masks":[
 {"id":"sky","kind":"linear","zero":{"x":0.5,"y":0.45},"full":{"x":0.52,"y":0.1},"adjust":{"exposure":-0.9,"highlights":-40,"saturation":15}},
 {"id":"object","kind":"radial","invert":true,"center":{"x":0.62,"y":0.66},"radius":{"x":0.2,"y":0.25},"angle":-25,"feather":45,"adjust":{"clarity":30,"relativeTemperature":-20,"hsl":["red",{"saturation":-30}]}}
]}"#;

fn cases(engine: &str) -> Vec<(&'static str, DevelopSettings)> {
    let mut base = DevelopSettings::neutral();
    base.engine = engine.into();
    base.look = look(engine).into();
    let mut exposure = base.clone();
    exposure.exposure = 0.3;
    let mut busy = base;
    busy.exposure = 0.2;
    busy.contrast = 18.0;
    busy.highlights = -60.0;
    busy.shadows = 40.0;
    busy.whites = 10.0;
    busy.blacks = -8.0;
    busy.texture = 12.0;
    busy.clarity = 15.0;
    busy.dehaze = 10.0;
    busy.vibrance = 12.0;
    busy.saturation = 5.0;
    let mut noise = busy.clone();
    noise.color_noise_reduction = 25.0;
    noise.color_noise_reduction_detail = 50.0;
    noise.color_noise_reduction_smoothness = 50.0;
    let mut cases = vec![
        ("exposure", exposure),
        ("busy", busy.clone()),
        ("colorNoise", noise),
    ];
    for preset in xmp::BUILTIN_PRESETS {
        if let Ok(result) = xmp::preset_settings(preset.xmp, Some(&busy)) {
            let mut settings = result.settings;
            settings.engine = engine.into();
            settings.look = look(engine).into();
            cases.push((preset.id, settings));
        }
    }
    if let Ok(masked) = parse_settings(
        &MASKED
            .replace("ENGINE", engine)
            .replace("LOOK", look(engine)),
    ) {
        cases.push(("masked", masked));
    }
    cases
}

/// Why a case was refused, with `RENDER_IDENTITY_VERBOSE=1` (natively).
fn explain(line: &str) {
    if std::env::var_os("RENDER_IDENTITY_VERBOSE").is_some() {
        eprintln!("{line}");
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// One digest per photo and engine: every case released (working size), and
/// the busy sliders and the masks dragged (long side 96). A refused case is
/// part of the digest.
fn digests() -> Vec<String> {
    digests_of(&PHOTOS)
}

/// The photos of the stages split in #150 that [`PHOTOS`] do not reach: a
/// signed RAW working copy of the camera whose NIHO 7 highlights take the
/// shoulder maps (`raw_highlight_shoulder.rs`).
const STAGE_PHOTOS: [(&str, &[&str]); 1] = [("signedShoulder", &["niho-7", "niho-11"])];

fn stage_digests() -> Vec<String> {
    digests_of(&STAGE_PHOTOS)
}

/// [`digests`] of `photos`.
fn digests_of(photos: &[(&str, &[&str])]) -> Vec<String> {
    let raster = raster();
    let unsigned = encode_working_copy(&unsigned_linear());
    let (signed, signed_meta) = signed_raw();
    let (shoulder, shoulder_meta) = signed_raw_of("sony-ilme-fx30");
    let mut out = Vec::new();
    for &(photo, engines) in photos {
        for &engine in engines {
            let mut digest = Sha256::new();
            let session = match photo {
                "raster" => Session::open_raster(&raster, 0, Filter::Lanczos3),
                "rasterCopy" => {
                    Session::open_working_copy(&unsigned, RASTER_META, Filter::Lanczos3)
                }
                "legacy" => {
                    Session::open_working_copy(&unsigned, LEGACY_RAW_META, Filter::Lanczos3)
                }
                "signedShoulder" => {
                    Session::open_working_copy(&shoulder, &shoulder_meta, Filter::Lanczos3)
                }
                _ => Session::open_working_copy(&signed, &signed_meta, Filter::Lanczos3),
            };
            match session {
                Err(error) => {
                    explain(&format!("{photo} {engine}: open: {error}"));
                    digest.update(b"open refused\n");
                }
                Ok(mut session) => {
                    for (case, settings) in cases(engine) {
                        let mut renders = vec![(0, Quality::Final)];
                        if matches!(case, "busy" | "masked") {
                            renders.push((96, Quality::Interactive));
                        }
                        for (size, quality) in renders {
                            let line = match session.render(&settings, size, quality) {
                                Ok(frame) => format!(
                                    "{case} {size} {}x{} {}\n",
                                    frame.width,
                                    frame.height,
                                    hex(&Sha256::digest(&frame.rgba))
                                ),
                                Err(error) => {
                                    explain(&format!("{photo} {engine} {case} {size}: {error}"));
                                    format!("{case} {size} refused\n")
                                }
                            };
                            digest.update(line.as_bytes());
                        }
                    }
                }
            }
            out.push(format!("{photo} {engine} {}", hex(&digest.finalize())));
        }
    }
    out
}

/// `photo engine sha256` (see [`digests`]).
const PINNED: &[&str] = &[
    "raster niho-1 ed86929f1ec0297c41e1fffd514f5ba8560b535061282a7faa3875c947eb16f0",
    "raster niho-2 99273e1ff9f7ab778b363c02c9249e1f9b9410af3080e4ef773652f17a75bde1",
    "raster niho-6 4747046b03493a0a688856c09487dd7894d07e6a51f58911f50173d0817a4c33",
    "raster niho-8 39e1db52b96a5c35af466a51ef0d29812bc60ffbebeaa211ce02ef098aab63e8",
    "raster niho-10 9c9f7afa688dbec8de630872128c7949789e4ab9144f6ae32ec9fd70a6375dcb",
    "raster niho-12 090ec6ad3d6f2c5d01f597eeac974cb9cd50beef414427f26b3c31f273b5ce14",
    "raster niho-13 f5b72730689d93693236848f1d6db5c84392f407fd62400364429dd4915c4402",
    "raster niho-14 dbc5d1a741f30ef65d684fbf295e1eed647e2becdce8bb9f85b8f82f043cfdba",
    "rasterCopy niho-6 369e394b9d52b03ee832fc4e39a25a4d034ebea7072bd12a9b6387a0351bae34",
    "rasterCopy niho-10 1da0092745206d5a65e094d6bd9c832e7d4797764eb1c862212c72412b2a24ae",
    "rasterCopy niho-14 140bf674d3e553748aa06269d631335d203b68018dec2dc5ea32f4520f7e6c07",
    "legacy niho-1 cee06b461880f215a8cbe082cc1f96902b47faf1c4823ccb05ca849998c53ee5",
    "legacy niho-14 c61834a1a42e511d2aaccb9ea3f6c99e8ab8533e608784c540b38a66d14751bb",
    "signed niho-3 674b87e311cbf977f6890f3ca743d52e114e8895eeb0056de996abcb57c9c2c3",
    "signed niho-4 0e616562b12660cd6dcb86d891ec74304a632df3453744d10de346604c90edbd",
    "signed niho-5 f5b22af03b0771a56e25e63f52adfb7abf4ccb31c291ebe7dbe89909abde3608",
    "signed niho-7 31d753dd9b609050345c1e73e728651f3d03740487d75abf6366fac1a9b6c54e",
    "signed niho-11 9d4c0a7f17cc583fc62935e48f64f731e16c21fd8f2938cb629e29a243687739",
];

/// `photo engine sha256` of [`STAGE_PHOTOS`] (see [`digests`]).
const STAGE_PINNED: &[&str] = &[
    "signedShoulder niho-7 477fadc05c47e219349b607d309fa785c2b1e8fe7d1bc8d314164c797e81d0fc",
    "signedShoulder niho-11 0ee87026d9101f16fc3fb56fb9a64ad117972589c4416c5541bf0dc629a2b577",
];

/// `digests` as drawn here.
#[cfg(not(feature = "threads"))]
fn computed(digests: fn() -> Vec<String>) -> Vec<String> {
    digests()
}

/// `digests` on 1 thread, after checking that 8 threads draw the same.
#[cfg(feature = "threads")]
fn computed(digests: fn() -> Vec<String>) -> Vec<String> {
    let on = |threads| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap()
            .install(digests)
    };
    let one = on(1);
    assert_eq!(on(8), one, "8 threads draw what 1 thread draws");
    one
}

fn assert_pinned(computed: Vec<String>, pinned: &[&str], name: &str) {
    assert_eq!(
        computed,
        pinned
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>(),
        "pinned digests (paste the left side into {name} after an engine change):\n{}",
        computed.join("\n")
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn every_engine_draws_the_pinned_bytes_however_the_work_is_split() {
    assert_pinned(computed(digests), PINNED, "PINNED");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_split_stages_draw_the_pinned_bytes_however_the_work_is_split() {
    assert_pinned(computed(stage_digests), STAGE_PINNED, "STAGE_PINNED");
}
