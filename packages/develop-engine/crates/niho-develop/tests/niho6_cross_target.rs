//! `niho-6` renders the same bytes natively and in browser wasm (spec
//! "段 2" 決まりごと 2, #18397 DoD): the analysis, the response networks
//! (`libm`, fixed accumulation order) and the gain. This test runs on both
//! targets and pins the RGBA hash of one synthetic photo.

use niho_develop::{encode, render, RenderOptions};

fn photo() -> Vec<u8> {
    let (w, h) = (160usize, 120usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    let mut state = 0x2f6b_4e1du32;
    for y in 0..h {
        for x in 0..w {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 7) as i32 - 3;
            // A dark room with a bright window and a saturated object.
            let window = x > 100 && y < 50;
            let object = (x as i32 - 40).pow(2) + (y as i32 - 80).pow(2) < 400;
            let (r, g, b) = if window {
                (235, 240, 250)
            } else if object {
                (170, 40, 30)
            } else {
                (20 + x as i32 / 8, 18 + y as i32 / 10, 16)
            };
            let c = |v: i32| (v + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_niho_6_bytes() {
    // The H/S response, the RAW Vibrance and HSL luminance, and the RAW
    // positive Blacks (#18397 R14 / R18).
    let settings = r#"{"v":1,"engine":"niho-6","look":"niho-standard-1","exposure":0.2,"highlights":-75,"shadows":55,"blacks":40,"vibrance":10,"hsl":{"orange":{"hue":0,"saturation":-10,"luminance":20}}}"#;
    let frame = render(
        &photo(),
        settings,
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!((frame.width, frame.height), (160, 120));
    assert_eq!(fnv1a64(&frame.rgba), 10_959_845_526_522_411_298);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_niho_8_bytes() {
    let input = photo();
    let settings = niho_develop::parse_settings(r#"{"v":1,"engine":"niho-8","look":"niho-standard-1","exposure":0.2,"highlights":-75,"shadows":55,"blacks":40,"vibrance":10,"hsl":{"orange":{"hue":0,"saturation":-10,"luminance":20}}}"#).unwrap();
    let final_frame = render(
        &input,
        &settings.to_json(),
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap();
    let mut session =
        niho_develop::Session::open_raster(&input, 0, niho_develop::Filter::Lanczos3).unwrap();
    let drag = session
        .render(&settings, 0, niho_develop::Quality::Interactive)
        .unwrap();
    assert_eq!(fnv1a64(&final_frame.rgba), 12_699_997_617_581_930_905);
    assert_eq!(fnv1a64(&drag.rgba), 15_324_851_065_599_780_084);
    assert_eq!((final_frame.width, final_frame.height), (160, 120));
    assert_eq!(
        session
            .render(&settings, 0, niho_develop::Quality::Final)
            .unwrap()
            .rgba,
        final_frame.rgba
    );
}

/// A legacy (unsigned) RAW working copy of the same synthetic photo.
fn legacy_raw_working_copy() -> Vec<u8> {
    let (w, h) = (96usize, 72usize);
    let image = niho_develop::LinearImage {
        width: w,
        height: h,
        data: (0..w * h)
            .flat_map(|i| {
                let (x, y) = (
                    (i % w) as f32 / (w - 1) as f32,
                    (i / w) as f32 / (h - 1) as f32,
                );
                [
                    0.01 + 0.8 * x * x,
                    0.02 + 0.5 * x * (1.0 - 0.4 * y),
                    0.03 + 0.35 * y + 0.2 * x,
                ]
            })
            .collect(),
    };
    niho_develop::decode::encode_working_copy(&image)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_niho_12_bytes() {
    // niho-12 is the new-edit default (#29): its raster Final / Interactive
    // and legacy RAW Final / Interactive bytes are frozen on both targets.
    let input = photo();
    let settings = niho_develop::parse_settings(r#"{"v":1,"engine":"niho-12","look":"niho-standard-1","exposure":0.2,"contrast":18,"highlights":-75,"shadows":55,"blacks":40,"vibrance":10,"saturation":-25,"hsl":{"orange":{"hue":0,"saturation":-10,"luminance":20}}}"#).unwrap();
    let final_frame = render(
        &input,
        &settings.to_json(),
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap();
    let mut session =
        niho_develop::Session::open_raster(&input, 0, niho_develop::Filter::Lanczos3).unwrap();
    let drag = session
        .render(&settings, 0, niho_develop::Quality::Interactive)
        .unwrap();
    assert_eq!((final_frame.width, final_frame.height), (160, 120));
    assert_eq!(fnv1a64(&final_frame.rgba), 16_491_360_035_185_789_091);
    assert_eq!(fnv1a64(&drag.rgba), 5_693_656_230_593_535_726);
    assert_eq!(
        session
            .render(&settings, 0, niho_develop::Quality::Final)
            .unwrap()
            .rgba,
        final_frame.rgba
    );

    let meta = r#"{"kind":"raw","baselineEV":0.3,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"fixture","lookTableIncluded":true}"#;
    let mut raw = niho_develop::Session::open_working_copy(
        &legacy_raw_working_copy(),
        meta,
        niho_develop::Filter::Lanczos3,
    )
    .unwrap();
    let raw_drag = raw
        .render(&settings, 0, niho_develop::Quality::Interactive)
        .unwrap();
    let raw_final = raw
        .render(&settings, 0, niho_develop::Quality::Final)
        .unwrap();
    assert_eq!((raw_final.width, raw_final.height), (96, 72));
    assert_eq!(fnv1a64(&raw_final.rgba), 7_566_227_202_881_651_497);
    assert_eq!(fnv1a64(&raw_drag.rgba), 14_103_212_438_157_733_202);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_niho_13_bytes() {
    // niho-13 is the new-edit default (#27): the relative white balance is
    // applied to the raster source (`head_wb.rs`). Its raster Final /
    // Interactive bytes with a white balance are frozen on both targets;
    // without one they are niho-12's (the hashes above), and its legacy RAW
    // path is niho-12's with or without one.
    const EDITS: &str = r#""look":"niho-standard-1","exposure":0.2,"contrast":18,"highlights":-75,"shadows":55,"blacks":40,"vibrance":10,"saturation":-25,"hsl":{"orange":{"hue":0,"saturation":-10,"luminance":20}}"#;
    let settings = |engine: &str, white: &str| {
        niho_develop::parse_settings(&format!(r#"{{"v":1,"engine":"{engine}",{EDITS}{white}}}"#))
            .unwrap()
    };
    const WARM: &str =
        r#","whiteBalance":{"mode":"relative"},"relativeTemperature":30,"relativeTint":20"#;
    let input = photo();
    let draw = |settings: &niho_develop::DevelopSettings| {
        let final_frame = render(
            &input,
            &settings.to_json(),
            &RenderOptions {
                max_dimension: 0,
                ..Default::default()
            },
        )
        .unwrap();
        let mut session =
            niho_develop::Session::open_raster(&input, 0, niho_develop::Filter::Lanczos3).unwrap();
        let drag = session
            .render(settings, 0, niho_develop::Quality::Interactive)
            .unwrap();
        let released = session
            .render(settings, 0, niho_develop::Quality::Final)
            .unwrap();
        assert_eq!(released.rgba, final_frame.rgba);
        assert_eq!((final_frame.width, final_frame.height), (160, 120));
        (fnv1a64(&final_frame.rgba), fnv1a64(&drag.rgba))
    };
    assert_eq!(
        draw(&settings("niho-13", "")),
        (16_491_360_035_185_789_091, 5_693_656_230_593_535_726)
    );
    let warm = draw(&settings("niho-13", WARM));
    assert_ne!(warm, draw(&settings("niho-12", WARM)));
    assert_eq!(
        warm,
        (12_987_301_143_173_593_065, 10_702_906_636_120_976_588)
    );

    let meta = r#"{"kind":"raw","baselineEV":0.3,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"fixture","lookTableIncluded":true}"#;
    for (white, expected) in [
        ("", (7_566_227_202_881_651_497, 14_103_212_438_157_733_202)),
        (WARM, (8_651_232_258_884_636_697, 259_039_195_463_019_758)),
    ] {
        let mut frames = Vec::new();
        for engine in ["niho-12", "niho-13"] {
            let mut raw = niho_develop::Session::open_working_copy(
                &legacy_raw_working_copy(),
                meta,
                niho_develop::Filter::Lanczos3,
            )
            .unwrap();
            let settings = settings(engine, white);
            let drag = raw
                .render(&settings, 0, niho_develop::Quality::Interactive)
                .unwrap();
            let released = raw
                .render(&settings, 0, niho_develop::Quality::Final)
                .unwrap();
            frames.push((fnv1a64(&released.rgba), fnv1a64(&drag.rgba)));
        }
        assert_eq!(frames[0], frames[1]);
        assert_eq!(frames[1], expected);
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_niho_14_bytes() {
    // niho-14 (#89) is niho-13 with the lighter H/S analysis (reduced large
    // local levels, f32 SIMD networks): its raster Final / Interactive bytes
    // with and without a white balance, and its coefficient maps, are frozen
    // on both targets.
    const EDITS: &str = r#""look":"niho-standard-1","exposure":0.2,"contrast":18,"highlights":-75,"shadows":55,"blacks":40,"vibrance":10,"saturation":-25,"hsl":{"orange":{"hue":0,"saturation":-10,"luminance":20}}"#;
    const WARM: &str =
        r#","whiteBalance":{"mode":"relative"},"relativeTemperature":30,"relativeTint":20"#;
    let input = photo();
    let draw = |white: &str| {
        let settings = niho_develop::parse_settings(&format!(
            r#"{{"v":1,"engine":"niho-14",{EDITS}{white}}}"#
        ))
        .unwrap();
        let final_frame = render(
            &input,
            &settings.to_json(),
            &RenderOptions {
                max_dimension: 0,
                ..Default::default()
            },
        )
        .unwrap();
        let mut session =
            niho_develop::Session::open_raster(&input, 0, niho_develop::Filter::Lanczos3).unwrap();
        let drag = session
            .render(&settings, 0, niho_develop::Quality::Interactive)
            .unwrap();
        let released = session
            .render(&settings, 0, niho_develop::Quality::Final)
            .unwrap();
        assert_eq!(released.rgba, final_frame.rgba);
        assert_eq!((final_frame.width, final_frame.height), (160, 120));
        (fnv1a64(&final_frame.rgba), fnv1a64(&drag.rgba))
    };
    let plain = draw("");
    let warm = draw(WARM);
    // The maps themselves (the networks' f32 lanes).
    let raster =
        niho_develop::decode::decode_raster(&input, 0, niho_develop::Filter::Lanczos3).unwrap();
    let analysis = niho_develop::niho6::analysis_of(
        &raster.image,
        niho_develop::niho6::SourceSpace::LinearSrgb,
        0.2,
        niho_develop::niho6::AnalysisKind::Light,
    )
    .unwrap();
    let maps = &analysis.maps;
    let bytes: Vec<u8> = [
        &maps.highlight_a,
        &maps.highlight_b,
        &maps.shadow_a,
        &maps.shadow_b,
    ]
    .into_iter()
    .flat_map(|map| map.iter().flat_map(|v| v.to_le_bytes()))
    .collect();
    assert_eq!(
        (plain, warm, fnv1a64(&bytes)),
        (
            (2_745_694_606_260_728_920, 8_524_083_090_913_131_645),
            (8_951_835_942_816_357_385, 14_020_425_707_676_210_481),
            16_180_419_554_140_804_340
        )
    );
}
