//! `niho-14` (#89, `NIHO14.md`) is `niho-13` with a lighter analysis of the
//! `niho-6` H/S response (the large local levels on reduced planes, `f32`
//! SIMD networks). Settings that do not use the response draw `niho-13`'s
//! bytes; with the response the frame stays within rounding of `niho-13`'s.
//! A Session keeps the two kinds of analysis apart. Its pixels are frozen
//! once saved.

use niho_develop::decode::{encode_signed_working_copy, encode_working_copy, LinearImage};
use niho_develop::niho6::{self, AnalysisKind, SourceSpace};
use niho_develop::settings::{
    WhiteBalanceMode, ENGINE_NIHO_13, ENGINE_NIHO_14, LOOK_NIHO_STANDARD_1,
};
use niho_develop::{
    encode, niho14_analysis, niho6_response, parse_settings, render_camera_linear, xmp,
    AsShotWhite, CameraLinearWorkMeta, DevelopSettings, Error, Filter, Quality, RenderOptions,
    Session,
};

const LEGACY_RAW_META: &str = r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"fixture","lookTableIncluded":true}"#;
const RASTER_META: &str = r#"{"kind":"raster","iccSha256":"sRGB"}"#;

/// A dark room with a bright window, a saturated object and noise, large
/// enough for the reduced local levels (the analysis keeps its size).
fn png() -> Vec<u8> {
    let (w, h) = (160usize, 120usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    let mut state = 0x2f6b_4e1du32;
    for y in 0..h {
        for x in 0..w {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 7) as i32 - 3;
            let window = x > 100 && y < 50;
            let object = (x as i32 - 40).pow(2) + (y as i32 - 80).pow(2) < 400;
            let (r, g, b) = if window {
                (235, 240, 250)
            } else if object {
                (170, 40, 30)
            } else {
                (20 + x as i32 / 2, 18 + y as i32 / 2, 16 + x as i32 / 3)
            };
            let c = |v: i32| (v + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

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

fn without_response(settings: &DevelopSettings) -> DevelopSettings {
    let mut settings = settings.clone();
    settings.highlights = 0.0;
    settings.shadows = 0.0;
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

/// The largest channel difference of two frames.
fn max_difference(a: &[u8], b: &[u8]) -> u8 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap()
}

#[test]
fn is_the_latest_reader_capability_without_changing_constructor_defaults() {
    assert_eq!(
        parse_settings(r#"{"engine":"niho-14","look":"niho-standard-1"}"#)
            .unwrap()
            .engine,
        ENGINE_NIHO_14
    );
    assert_eq!(niho_develop::ENGINE_VERSION, ENGINE_NIHO_14);
    assert_eq!(niho_develop::CRATE_VERSION, "0.26.0");
    assert_eq!(DevelopSettings::neutral().engine, "niho-1");
    assert_eq!(DevelopSettings::new_edit().engine, "niho-1");
    assert!(parse_settings(r#"{"v":1,"engine":"niho-14","look":"niho-standard-5"}"#).is_err());
}

#[test]
fn without_the_response_it_draws_niho13_bytes_everywhere() {
    let png = png();
    let wc = encode_working_copy(&prophoto());
    for crop in [false, true] {
        for (temperature, tint) in [(0.0, 0.0), (30.0, 20.0), (-40.0, 0.0)] {
            let thirteen = without_response(&settings(ENGINE_NIHO_13, temperature, tint));
            let thirteen = if crop { cropped(&thirteen) } else { thirteen };
            let fourteen = with_engine(&thirteen, ENGINE_NIHO_14);
            assert_eq!(one_shot(&png, &fourteen), one_shot(&png, &thirteen));
            for (bytes, meta) in [
                (&png, None),
                (&wc, Some(RASTER_META)),
                (&wc, Some(LEGACY_RAW_META)),
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
                        a.render(&fourteen, 48, quality).unwrap().rgba,
                        b.render(&thirteen, 48, quality).unwrap().rgba,
                        "{meta:?} crop={crop} {temperature}/{tint} {quality:?}"
                    );
                }
                assert_eq!(
                    a.sample_color(&fourteen, 0, 0.3, 0.6).unwrap(),
                    b.sample_color(&thirteen, 0, 0.3, 0.6).unwrap()
                );
            }
        }
    }
}

#[test]
fn legacy_raw_is_niho13_with_the_response_settings_too() {
    let wc = encode_working_copy(&prophoto());
    let mut session = Session::open_working_copy(&wc, LEGACY_RAW_META, Filter::Lanczos3).unwrap();
    for (temperature, tint) in [(0.0, 0.0), (30.0, -20.0)] {
        for quality in [Quality::Final, Quality::Interactive] {
            let thirteen = settings(ENGINE_NIHO_13, temperature, tint);
            assert_eq!(
                session
                    .render(&with_engine(&thirteen, ENGINE_NIHO_14), 0, quality)
                    .unwrap()
                    .rgba,
                session.render(&thirteen, 0, quality).unwrap().rgba,
                "{temperature}/{tint} {quality:?}"
            );
        }
    }
}

#[test]
fn the_light_analysis_stays_within_rounding_of_niho13() {
    let png = png();
    let raster = niho_develop::decode::decode_raster(&png, 0, Filter::Lanczos3).unwrap();
    let frozen = niho6::analysis_of(
        &raster.image,
        SourceSpace::LinearSrgb,
        0.2,
        AnalysisKind::Frozen,
    )
    .unwrap();
    let light = niho6::analysis_of(
        &raster.image,
        SourceSpace::LinearSrgb,
        0.2,
        AnalysisKind::Light,
    )
    .unwrap();
    assert_eq!(frozen.kind, AnalysisKind::Frozen);
    assert_eq!(light.kind, AnalysisKind::Light);
    // The gains (EV) of the strongest amounts.
    let (fh, fs) = niho6_response::gains(&frozen.maps, -100.0, 100.0).unwrap();
    let (lh, ls) = niho6_response::gains(&light.maps, -100.0, 100.0).unwrap();
    let worst = fh
        .iter()
        .zip(&lh)
        .chain(fs.iter().zip(&ls))
        .map(|(a, b)| (a - b).abs())
        .fold(0.0_f32, f32::max);
    assert!(worst < 2e-3, "{worst} EV");
    assert!(worst > 0.0, "a different computation");
    // Frames: at most one 8-bit code apart, and not the same bytes.
    for (temperature, tint) in [(0.0, 0.0), (30.0, 20.0)] {
        let thirteen = settings(ENGINE_NIHO_13, temperature, tint);
        let fourteen = with_engine(&thirteen, ENGINE_NIHO_14);
        let (a, b) = (one_shot(&png, &thirteen), one_shot(&png, &fourteen));
        assert!(max_difference(&a, &b) <= 1, "{temperature}/{tint}");
    }
}

#[test]
fn portable_networks_are_the_targets_networks() {
    let png = png();
    let raster = niho_develop::decode::decode_raster(&png, 0, Filter::Lanczos3).unwrap();
    let small = niho6::analysis_image(&raster.image, SourceSpace::LinearSrgb);
    let features = niho14_analysis::features(&small.data, small.width, small.height).unwrap();
    for exposure in [0.0, -1.3, 0.7] {
        let target = niho14_analysis::coefficient_maps_at(&features, exposure).unwrap();
        let portable = niho14_analysis::coefficient_maps_portable(&features, exposure).unwrap();
        for (a, b) in [
            (&target.highlight_a, &portable.highlight_a),
            (&target.highlight_b, &portable.highlight_b),
            (&target.shadow_a, &portable.shadow_a),
            (&target.shadow_b, &portable.shadow_b),
        ] {
            assert!(a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits()));
        }
    }
}

#[test]
fn a_session_keeps_the_two_analyses_apart_and_matches_one_shot() {
    let png = png();
    for crop in [false, true] {
        let at = |engine: &str, temperature: f64| {
            let s = settings(engine, temperature, 8.0);
            if crop {
                cropped(&s)
            } else {
                s
            }
        };
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        // Alternate the engines on one Session; every released frame is the
        // one-shot frame of its own engine.
        for engine in [
            ENGINE_NIHO_13,
            ENGINE_NIHO_14,
            ENGINE_NIHO_13,
            ENGINE_NIHO_14,
        ] {
            let released = session
                .render(&at(engine, -30.0), 0, Quality::Final)
                .unwrap();
            assert_eq!(
                released.rgba,
                one_shot(&png, &at(engine, -30.0)),
                "{engine}"
            );
        }
        // A drag of the white balance and its release.
        for temperature in [-20.0, -5.0, 10.0, 25.0] {
            session
                .render(&at(ENGINE_NIHO_14, temperature), 0, Quality::Interactive)
                .unwrap();
        }
        let released = session
            .render(&at(ENGINE_NIHO_14, 25.0), 0, Quality::Final)
            .unwrap();
        assert_eq!(released.rgba, one_shot(&png, &at(ENGINE_NIHO_14, 25.0)));
        // An Interactive frame of the other engine never reuses this one's
        // analysis.
        let interactive = session
            .render(&at(ENGINE_NIHO_13, 25.0), 0, Quality::Interactive)
            .unwrap();
        let fresh = Session::open_raster(&png, 0, Filter::Lanczos3)
            .unwrap()
            .render(&at(ENGINE_NIHO_13, 25.0), 0, Quality::Interactive)
            .unwrap();
        assert_eq!(interactive.rgba, fresh.rgba, "crop={crop}");
    }
}

#[test]
fn raster_working_copies_use_the_light_analysis() {
    let image = prophoto();
    let wc = encode_working_copy(&image);
    let fourteen = settings(ENGINE_NIHO_14, -35.0, 25.0);
    let mut session = Session::open_working_copy(&wc, RASTER_META, Filter::Lanczos3).unwrap();
    session
        .render(&settings(ENGINE_NIHO_13, -35.0, 25.0), 0, Quality::Final)
        .unwrap();
    let frame = session.render(&fourteen, 0, Quality::Final).unwrap().rgba;
    let one_shot = niho_develop::render_working_copy(
        &wc,
        RASTER_META,
        &fourteen.to_json(),
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap()
    .rgba;
    assert_eq!(frame, one_shot);
}

#[test]
fn signed_raw_and_camera_linear_are_refused() {
    let image = prophoto();
    let (signed, encoding) = encode_signed_working_copy(&image).unwrap();
    let signed_meta = format!(
        r#"{{"kind":"raw","baselineEV":0,"asShotWhite":{{"x":0.3457,"y":0.3585}},"dcpSha256":"fixture","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    let error = Session::open_working_copy(&signed, &signed_meta, Filter::Lanczos3)
        .unwrap()
        .render(&settings(ENGINE_NIHO_14, 30.0, 0.0), 0, Quality::Final)
        .unwrap_err();
    assert!(matches!(
        error,
        Error::IncompatibleWorkingCopy(message)
            if message == "niho-14 does not define signed-gamma18-v1 semantics; use niho-3/4/5/7/11"
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
            &settings(ENGINE_NIHO_14, 0.0, 0.0),
            &RenderOptions::default()
        ),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-14 camera-linear input is unsupported; use a raster or legacy unsigned RAW working copy"
    ));
}

#[test]
fn presets_and_xmp_keep_niho14() {
    let base = settings(ENGINE_NIHO_14, 0.0, 0.0);
    for preset in ["niho-colorful", "niho-bluesky2", "niho-pastel"] {
        let applied =
            xmp::apply_preset(xmp::builtin_preset(preset).unwrap().xmp, &base, 1.0, None).unwrap();
        assert_eq!(applied.settings.engine, ENGINE_NIHO_14, "{preset}");
        assert_eq!(applied.settings.look, LOOK_NIHO_STANDARD_1);
    }
    let incremental = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Custom" crs:IncrementalTemperature="12" crs:IncrementalTint="-4"/></rdf:RDF></x:xmpmeta>"#;
    let kept = xmp::apply_preset(incremental, &base, 1.0, None).unwrap();
    assert_eq!(kept.settings.engine, ENGINE_NIHO_14);
    let written = xmp::settings_to_xmp(
        &kept.settings,
        &xmp::XmpWriteOptions {
            name: "niho-14".into(),
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
