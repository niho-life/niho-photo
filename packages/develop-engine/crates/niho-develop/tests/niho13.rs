//! `niho-13` (#27) is `niho-12` with the relative white balance of raster
//! sources applied to the source (the measured incremental-WB delta on the
//! encoded sRGB, `head_wb.rs`) instead of to the 8-bit output. Legacy
//! unsigned RAW working copies render exactly as `niho-12`; signed RAW and
//! camera-linear input are refused. Its pixels are frozen once saved.

use niho_develop::decode::{
    decode_raster, encode_signed_working_copy, encode_working_copy, LinearImage, Raster,
};
use niho_develop::head_wb::HeadWhiteBalance;
use niho_develop::niho6::SourceSpace;
use niho_develop::pipeline::{self, WorkingCopy};
use niho_develop::settings::{
    WhiteBalanceMode, ENGINE_NIHO_12, ENGINE_NIHO_13, LOOK_NIHO_STANDARD_1,
};
use niho_develop::{
    encode, parse_settings, render_camera_linear, xmp, AsShotWhite, CameraLinearWorkMeta,
    DevelopSettings, Error, Filter, Quality, RenderOptions, Session, WorkingCopyMeta,
};

const LEGACY_RAW_META: &str = r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"fixture","lookTableIncluded":true}"#;
const RASTER_META: &str = r#"{"kind":"raster","iccSha256":"sRGB"}"#;

/// A dark room with a bright window, a saturated object and noise (the
/// `niho6_cross_target` scene at a smaller size).
fn png() -> Vec<u8> {
    let (w, h) = (96usize, 72usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    let mut state = 0x2f6b_4e1du32;
    for y in 0..h {
        for x in 0..w {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 7) as i32 - 3;
            let window = x > 60 && y < 30;
            let object = (x as i32 - 24).pow(2) + (y as i32 - 48).pow(2) < 150;
            let (r, g, b) = if window {
                (235, 240, 250)
            } else if object {
                (170, 40, 30)
            } else {
                (20 + x as i32 * 2, 18 + y as i32 * 2, 16 + x as i32)
            };
            let c = |v: i32| (v + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

/// Linear ProPhoto with colors outside sRGB and values above 1.
fn prophoto() -> LinearImage {
    let (w, h) = (40usize, 30usize);
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
                    0.01 + 0.9 * x * x,
                    0.02 + 1.3 * x * (1.0 - 0.5 * y),
                    0.03 + 0.5 * y * y,
                ]
            })
            .collect(),
    }
}

fn settings(engine: &str, temperature: f64, tint: f64) -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.engine = engine.into();
    settings.look = LOOK_NIHO_STANDARD_1.into();
    settings.exposure = 0.2;
    settings.contrast = 18.0;
    settings.highlights = -60.0;
    settings.shadows = 40.0;
    settings.clarity = 15.0;
    settings.vibrance = 12.0;
    settings.saturation = -20.0;
    with_white(settings, temperature, tint)
}

fn with_white(mut settings: DevelopSettings, temperature: f64, tint: f64) -> DevelopSettings {
    settings.white_balance.mode = if temperature == 0.0 && tint == 0.0 {
        WhiteBalanceMode::AsShot
    } else {
        WhiteBalanceMode::Relative
    };
    settings.relative_temperature = temperature;
    settings.relative_tint = tint;
    settings
}

fn with_engine(settings: &DevelopSettings, engine: &str) -> DevelopSettings {
    let mut settings = settings.clone();
    settings.engine = engine.into();
    settings
}

fn cropped(settings: &DevelopSettings) -> DevelopSettings {
    let mut value = settings.to_value();
    value["v"] = 2.into();
    value["geometry"] = serde_json::json!({"rotate":90,"angle":3.0,"crop":{"left":0.1,"top":0.15,"right":0.85,"bottom":0.9}});
    DevelopSettings::from_json(&value.to_string()).unwrap()
}

fn one_shot(png: &[u8], settings: &DevelopSettings) -> Vec<u8> {
    niho_develop::render(
        png,
        &settings.to_json(),
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap()
    .rgba
}

#[test]
fn is_the_latest_reader_capability_without_changing_constructor_defaults() {
    assert_eq!(
        parse_settings(r#"{"engine":"niho-13","look":"niho-standard-1"}"#)
            .unwrap()
            .engine,
        ENGINE_NIHO_13
    );
    // The latest reader capability is `niho-14` (`tests/niho14.rs`).
    assert!(niho_develop::settings::is_known_engine(ENGINE_NIHO_13));
    assert_eq!(DevelopSettings::neutral().engine, "niho-1");
    assert_eq!(DevelopSettings::new_edit().engine, "niho-1");
    assert!(parse_settings(r#"{"v":1,"engine":"niho-13","look":"niho-standard-5"}"#).is_err());
}

#[test]
fn zero_white_balance_draws_niho12_bytes_everywhere() {
    let png = png();
    let wc = encode_working_copy(&prophoto());
    let legacy_raw = encode_working_copy(&prophoto());
    for crop in [false, true] {
        for (temperature, tint, relative) in [(0.0, 0.0, false), (0.0, 0.0, true)] {
            let mut twelve = settings(ENGINE_NIHO_12, temperature, tint);
            if relative {
                // A relative mode with both increments at zero is no white
                // balance either.
                twelve.white_balance.mode = WhiteBalanceMode::Relative;
            }
            let twelve = if crop { cropped(&twelve) } else { twelve };
            let thirteen = with_engine(&twelve, ENGINE_NIHO_13);
            assert_eq!(one_shot(&png, &thirteen), one_shot(&png, &twelve));
            for (bytes, meta) in [
                (&png, None),
                (&wc, Some(RASTER_META)),
                (&legacy_raw, Some(LEGACY_RAW_META)),
            ] {
                let open = || match meta {
                    None => Session::open_raster(bytes, 0, Filter::Lanczos3).unwrap(),
                    Some(meta) => {
                        Session::open_working_copy(bytes, meta, Filter::Lanczos3).unwrap()
                    }
                };
                let (mut a, mut b) = (open(), open());
                for quality in [Quality::Interactive, Quality::Final] {
                    assert_eq!(
                        a.render(&thirteen, 48, quality).unwrap().rgba,
                        b.render(&twelve, 48, quality).unwrap().rgba,
                        "{meta:?} crop={crop} {quality:?}"
                    );
                }
                assert_eq!(
                    a.sample_color(&thirteen, 0, 0.3, 0.6).unwrap(),
                    b.sample_color(&twelve, 0, 0.3, 0.6).unwrap()
                );
            }
        }
    }
    let mut auto12 = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let mut auto13 = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let twelve = settings(ENGINE_NIHO_12, 0.0, 0.0);
    let a = auto12.auto_settings(&twelve).unwrap();
    let b = auto13
        .auto_settings(&with_engine(&twelve, ENGINE_NIHO_13))
        .unwrap();
    assert_eq!(with_engine(&a, ENGINE_NIHO_13).to_json(), b.to_json());
}

#[test]
fn raster_white_balance_is_the_measured_delta_on_the_source() {
    let png = png();
    let raster = decode_raster(&png, 0, Filter::Lanczos3).unwrap();
    for (temperature, tint) in [
        (30.0, 0.0),
        (-30.0, 0.0),
        (0.0, 20.0),
        (30.0, 20.0),
        (-64.0, -41.0),
    ] {
        let thirteen = settings(ENGINE_NIHO_13, temperature, tint);
        // The source balanced first, then the `niho-12` frame of the other
        // edits (no white balance left in its settings).
        let balanced = Raster {
            image: HeadWhiteBalance { temperature, tint }
                .prepare()
                .apply_image(&raster.image, SourceSpace::LinearSrgb),
            info: raster.info.clone(),
        };
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        let frame = session.render(&thirteen, 0, Quality::Final).unwrap().rgba;
        assert_eq!(frame, one_shot(&png, &thirteen), "{temperature}/{tint}");
        // The engine's frame is the `niho-12` frame (no white balance left)
        // of the balanced raster.
        let mut no_response = thirteen.clone();
        no_response.highlights = 0.0;
        no_response.shadows = 0.0;
        let rest = with_white(with_engine(&no_response, ENGINE_NIHO_12), 0.0, 0.0);
        assert_eq!(
            pipeline::render_raster(&raster, &no_response, Quality::Final, None, None)
                .0
                .rgba,
            pipeline::render_raster(&balanced, &rest, Quality::Final, None, None)
                .0
                .rgba,
            "{temperature}/{tint}"
        );
        // The placement differs from niho-12's output-side LUT on edits.
        assert_ne!(
            frame,
            one_shot(&png, &with_engine(&thirteen, ENGINE_NIHO_12))
        );
    }
    // A neutral edit draws the balanced source as it is: no output
    // transform (a bounded source stays bounded), each byte the balanced
    // linear value encoded.
    let mut neutral = DevelopSettings::new_edit();
    neutral.engine = ENGINE_NIHO_13.into();
    let neutral = with_white(neutral, 30.0, 20.0);
    let prepared = HeadWhiteBalance {
        temperature: 30.0,
        tint: 20.0,
    }
    .prepare();
    let encoder = niho_develop::fastmath::srgb8();
    let expected: Vec<u8> = raster
        .image
        .data
        .chunks_exact(3)
        .flat_map(|px| {
            let v = prepared.apply_linear_srgb([px[0], px[1], px[2]]);
            [
                encoder.encode(v[0].clamp(0.0, 1.0)),
                encoder.encode(v[1].clamp(0.0, 1.0)),
                encoder.encode(v[2].clamp(0.0, 1.0)),
                255,
            ]
        })
        .collect();
    assert_eq!(one_shot(&png, &neutral), expected);
}

#[test]
fn session_caches_follow_the_white_balance() {
    let png = png();
    let fresh = |settings: &DevelopSettings, quality: Quality| {
        Session::open_raster(&png, 0, Filter::Lanczos3)
            .unwrap()
            .render(settings, 0, quality)
            .unwrap()
            .rgba
    };
    for crop in [false, true] {
        let at = |temperature: f64, tint: f64| {
            let s = settings(ENGINE_NIHO_13, temperature, tint);
            if crop {
                cropped(&s)
            } else {
                s
            }
        };
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        // Released frames at one white balance, then a drag to another.
        session.render(&at(-30.0, 0.0), 0, Quality::Final).unwrap();
        for temperature in [-20.0, -5.0, 10.0, 25.0] {
            session
                .render(&at(temperature, 8.0), 0, Quality::Interactive)
                .unwrap();
        }
        // The released frame never keeps the drag's analysis, pass or source.
        let released = session.render(&at(25.0, 8.0), 0, Quality::Final).unwrap();
        assert_eq!(
            released.rgba,
            fresh(&at(25.0, 8.0), Quality::Final),
            "crop={crop}"
        );
        assert_eq!(released.rgba, one_shot(&png, &at(25.0, 8.0)));
        // Back to no white balance: the niho-12 bytes, no stale balanced source.
        assert_eq!(
            session
                .render(&at(0.0, 0.0), 0, Quality::Final)
                .unwrap()
                .rgba,
            one_shot(&png, &with_engine(&at(0.0, 0.0), ENGINE_NIHO_12))
        );
        // Preset previews balance their own reduction and leave the parent's
        // next frame as it was.
        let mut preview = session.thumbnail(32);
        preview.render(&at(-50.0, 30.0), 0, Quality::Final).unwrap();
        assert_eq!(
            session
                .render(&at(25.0, 8.0), 0, Quality::Final)
                .unwrap()
                .rgba,
            released.rgba
        );
        let mut fresh_preview = Session::open_raster(&png, 0, Filter::Lanczos3)
            .unwrap()
            .thumbnail(32);
        assert_eq!(
            session
                .thumbnail(32)
                .render(&at(-50.0, 30.0), 0, Quality::Final)
                .unwrap()
                .rgba,
            fresh_preview
                .render(&at(-50.0, 30.0), 0, Quality::Final)
                .unwrap()
                .rgba
        );
    }
}

#[test]
fn picker_auto_and_color_points_read_the_balanced_source() {
    let png = png();
    let thirteen = settings(ENGINE_NIHO_13, 40.0, -15.0);
    // One Session already drew this white balance, the other another one.
    let mut warm = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    warm.render(&thirteen, 0, Quality::Final).unwrap();
    let mut cold = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    cold.render(&settings(ENGINE_NIHO_13, -40.0, 0.0), 0, Quality::Final)
        .unwrap();
    // The sample follows the settings' white balance whatever the Session
    // drew last.
    let sample = warm.sample_color(&thirteen, 0, 0.3, 0.6).unwrap();
    assert_eq!(cold.sample_color(&thirteen, 0, 0.3, 0.6).unwrap(), sample);
    assert_ne!(
        sample,
        warm.sample_color(&with_white(thirteen.clone(), 0.0, 0.0), 0, 0.3, 0.6)
            .unwrap()
    );
    // Auto reads the balanced photo.
    assert_eq!(
        warm.auto_settings(&thirteen).unwrap().to_json(),
        cold.auto_settings(&thirteen).unwrap().to_json()
    );
    let zero = with_white(thirteen.clone(), 0.0, 0.0);
    let mut plain = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    assert_ne!(
        plain.auto_settings(&zero).unwrap().to_json(),
        with_white(warm.auto_settings(&thirteen).unwrap(), 0.0, 0.0).to_json()
    );

    // The point plane of one white balance never serves another (no local
    // pass here: a drag of the balance may keep the pass of the frame
    // before, `session_caches_follow_the_white_balance`).
    let mut points = thirteen.clone();
    points.highlights = 0.0;
    points.shadows = 0.0;
    points.clarity = 0.0;
    points.v = 4;
    points.color_points = vec![niho_develop::settings::ColorPoint {
        id: "p".into(),
        target: niho_develop::settings::OklchTarget {
            lightness: sample[0],
            chroma: sample[1],
            hue: sample[2],
        },
        range: niho_develop::settings::OklchRange {
            hue: 30.0,
            chroma: 0.08,
            lightness: 0.2,
        },
        delta: niho_develop::settings::OklchDelta {
            hue: 25.0,
            chroma_scale: 1.4,
            lightness: 0.05,
        },
    }];
    let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    for quality in [Quality::Final, Quality::Interactive] {
        session.render(&points, 0, quality).unwrap();
        let other = with_white(points.clone(), -40.0, 0.0);
        assert_eq!(
            session.render(&other, 0, quality).unwrap().rgba,
            Session::open_raster(&png, 0, Filter::Lanczos3)
                .unwrap()
                .render(&other, 0, quality)
                .unwrap()
                .rgba
        );
    }
}

#[test]
fn raster_working_copies_are_balanced_in_linear_srgb() {
    let image = prophoto();
    let wc = encode_working_copy(&image);
    let thirteen = settings(ENGINE_NIHO_13, -35.0, 25.0);
    let mut session = Session::open_working_copy(&wc, RASTER_META, Filter::Lanczos3).unwrap();
    session
        .render(&settings(ENGINE_NIHO_13, 20.0, 0.0), 0, Quality::Final)
        .unwrap();
    let frame = session.render(&thirteen, 0, Quality::Final).unwrap().rgba;
    let one_shot = niho_develop::render_working_copy(
        &wc,
        RASTER_META,
        &thirteen.to_json(),
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap()
    .rgba;
    assert_eq!(frame, one_shot);
    // The pipeline's one-shot working-copy entry balances it as well.
    let meta = WorkingCopyMeta::from_json(RASTER_META).unwrap();
    let decoded =
        niho_develop::decode::decode_working_copy_with_meta(&wc, &meta, 0, Filter::Lanczos3)
            .unwrap();
    let mut no_response = thirteen.clone();
    no_response.highlights = 0.0;
    no_response.shadows = 0.0;
    let balanced = HeadWhiteBalance {
        temperature: -35.0,
        tint: 25.0,
    }
    .prepare()
    .apply_image(&decoded, SourceSpace::LinearProPhoto);
    let rest = with_white(with_engine(&no_response, ENGINE_NIHO_12), 0.0, 0.0);
    assert_eq!(
        pipeline::render_working_copy(
            &WorkingCopy {
                image: &decoded,
                meta: &meta
            },
            &no_response,
            Quality::Final,
            None
        )
        .0
        .rgba,
        pipeline::render_working_copy(
            &WorkingCopy {
                image: &balanced,
                meta: &meta
            },
            &rest,
            Quality::Final,
            None
        )
        .0
        .rgba
    );
    // Colors outside sRGB keep their excursion through the balance (the
    // working copy's out-of-gamut greens stay out of gamut).
    let srgb = |p: &[f32]| {
        niho_develop::color::mat_vec_f32(
            &niho_develop::color::PROPHOTO_TO_SRGB_F32,
            [p[0], p[1], p[2]],
        )
    };
    let outside = decoded
        .data
        .chunks_exact(3)
        .zip(balanced.data.chunks_exact(3))
        .filter(|(before, _)| srgb(before).iter().any(|v| *v < 0.0 || *v > 1.0))
        .count();
    assert!(outside > 0);
    for (before, after) in decoded
        .data
        .chunks_exact(3)
        .zip(balanced.data.chunks_exact(3))
    {
        let (b, a) = (srgb(before), srgb(after));
        for channel in 0..3 {
            assert!(a[channel].is_finite());
            assert!(a[channel] >= b[channel].min(0.0) - 1e-4, "{b:?} -> {a:?}");
            assert!(a[channel] <= b[channel].max(1.0) + 1e-4, "{b:?} -> {a:?}");
        }
    }
}

#[test]
fn legacy_raw_is_niho12_and_signed_raw_and_camera_linear_are_refused() {
    let image = prophoto();
    let png = encode_working_copy(&image);
    let mut session = Session::open_working_copy(&png, LEGACY_RAW_META, Filter::Lanczos3).unwrap();
    for (temperature, tint) in [(0.0, 0.0), (30.0, -20.0), (-70.0, 45.0)] {
        for quality in [Quality::Final, Quality::Interactive] {
            let twelve = settings(ENGINE_NIHO_12, temperature, tint);
            let thirteen = with_engine(&twelve, ENGINE_NIHO_13);
            assert_eq!(
                session.render(&thirteen, 0, quality).unwrap().rgba,
                session.render(&twelve, 0, quality).unwrap().rgba,
                "{temperature}/{tint} {quality:?}"
            );
        }
    }
    let (signed, encoding) = encode_signed_working_copy(&image).unwrap();
    let signed_meta = format!(
        r#"{{"kind":"raw","baselineEV":0,"asShotWhite":{{"x":0.3457,"y":0.3585}},"dcpSha256":"fixture","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    let error = Session::open_working_copy(&signed, &signed_meta, Filter::Lanczos3)
        .unwrap()
        .render(&settings(ENGINE_NIHO_13, 30.0, 0.0), 0, Quality::Final)
        .unwrap_err();
    assert!(matches!(
        error,
        Error::IncompatibleWorkingCopy(message)
            if message == "niho-13 does not define signed-gamma18-v1 semantics; use niho-3/4/5/7/11"
    ));
    let meta = CameraLinearWorkMeta {
        expected_dcp_sha256: "0".repeat(64),
        expected_unique_camera_model: "fixture".into(),
        base_version: "fixture".into(),
        as_shot_camera_neutral: [0.5, 1.0, 0.75],
        raw_baseline_ev: 0.0,
        as_shot_white: AsShotWhite {
            x: 0.3127,
            y: 0.329,
            temperature: Some(5500.0),
            tint: Some(0.0),
        },
    };
    assert!(matches!(
        render_camera_linear(
            &image,
            &[],
            &meta,
            &settings(ENGINE_NIHO_13, 0.0, 0.0),
            &RenderOptions::default()
        ),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-13 camera-linear input is unsupported; use a raster or legacy unsigned RAW working copy"
    ));
}

#[test]
fn presets_and_xmp_keep_niho13() {
    let base = settings(ENGINE_NIHO_13, 0.0, 0.0);
    for preset in ["niho-colorful", "niho-bluesky2", "niho-pastel"] {
        let applied =
            xmp::apply_preset(xmp::builtin_preset(preset).unwrap().xmp, &base, 1.0, None).unwrap();
        assert_eq!(applied.settings.engine, ENGINE_NIHO_13, "{preset}");
        assert_eq!(applied.settings.look, LOOK_NIHO_STANDARD_1);
    }
    let incremental = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Custom" crs:IncrementalTemperature="12" crs:IncrementalTint="-4"/></rdf:RDF></x:xmpmeta>"#;
    let kept = xmp::apply_preset(incremental, &base, 1.0, None).unwrap();
    assert_eq!(kept.settings.engine, ENGINE_NIHO_13);
    assert_eq!(
        (
            kept.settings.relative_temperature,
            kept.settings.relative_tint
        ),
        (12.0, -4.0)
    );
    // The XMP is Lightroom's Custom + Incremental, as for niho-2 .. niho-12.
    let written = xmp::settings_to_xmp(
        &kept.settings,
        &xmp::XmpWriteOptions {
            name: "niho-13".into(),
            uuid: None,
            groups: xmp::XmpGroup::ALL.to_vec(),
        },
    );
    assert!(written.not_written.is_empty(), "{:?}", written.not_written);
    let document = xmp::parse(&written.xmp).unwrap();
    assert_eq!(document.properties["WhiteBalance"], "Custom");
    assert_eq!(document.properties["IncrementalTemperature"], "+12");
    assert_eq!(document.properties["IncrementalTint"], "-4");
}
