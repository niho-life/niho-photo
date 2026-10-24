use niho_develop::decode::{
    decode_working_copy, decode_working_copy_with_meta, encode_signed_working_copy,
};
use niho_develop::settings::{
    HslAdjustment, HslBand, WhiteBalanceMode, ENGINE_NIHO_2, ENGINE_NIHO_3, LOOK_NIHO_INTERIM_1,
    LOOK_NIHO_STANDARD_2,
};
use niho_develop::{
    encode, parse_settings, render_working_copy, xmp, DevelopSettings, Error, Filter, LinearImage,
    Quality, RenderOptions, Session, WorkingCopyEncoding, WorkingCopyMeta,
};

fn image(width: usize, height: usize) -> LinearImage {
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            let u = x as f32 / width.max(1) as f32;
            let v = y as f32 / height.max(1) as f32;
            data.extend_from_slice(&[-0.12 + 2.4 * u, 0.02 + 1.3 * v, 0.08 + 0.8 * (u - v).abs()]);
        }
    }
    LinearImage {
        width,
        height,
        data,
    }
}

fn metadata(ceiling: f64) -> String {
    format!(
        r#"{{"kind":"raw","baselineEV":0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":4}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"fixture","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{ceiling}}}}}"#
    )
}

fn niho3() -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.engine = ENGINE_NIHO_3.into();
    settings.look = LOOK_NIHO_STANDARD_2.into();
    settings
}

fn with_geometry(base: &DevelopSettings, geometry: &str) -> DevelopSettings {
    let mut value = base.to_value();
    value["v"] = 2.into();
    value["geometry"] = serde_json::from_str(geometry).unwrap();
    DevelopSettings::from_json(&value.to_string()).unwrap()
}

#[test]
fn signed_encoding_round_trips_negative_zero_and_headroom() {
    let source = LinearImage {
        width: 2,
        height: 1,
        data: vec![-0.25, 0.0, 0.5, 1.0, 2.25, -3.5],
    };
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let ceiling = match encoding {
        WorkingCopyEncoding::SignedGamma18V1 { ceiling } => ceiling,
    };
    assert_eq!(ceiling, 4.0);
    let meta = WorkingCopyMeta::from_json(&metadata(ceiling)).unwrap();
    let decoded = decode_working_copy_with_meta(&png, &meta, 0, Filter::Lanczos3).unwrap();
    for (actual, expected) in decoded.data.iter().zip(&source.data) {
        assert!((actual - expected).abs() < 2e-4, "{actual} vs {expected}");
    }
    // The compatibility entry remains the legacy unsigned decoder.
    let legacy = decode_working_copy(&png, 0, Filter::Lanczos3).unwrap();
    assert_ne!(legacy.data, decoded.data);
}

#[test]
fn signed_metadata_rejects_unknown_or_invalid_encodings() {
    for encoding in [
        r#"{"kind":"future","ceiling":4}"#,
        r#"{"kind":"signed-gamma18-v1","ceiling":3}"#,
        r#"{"kind":"signed-gamma18-v1","ceiling":0}"#,
        r#"{"kind":"signed-gamma18-v1","ceiling":131072}"#,
        r#"{"kind":"signed-gamma18-v1","ceiling":"4"}"#,
        r#"{"kind":"signed-gamma18-v1","ceiling":4,"extra":1}"#,
    ] {
        let text = metadata(4.0).replace(r#"{"kind":"signed-gamma18-v1","ceiling":4}"#, encoding);
        assert!(WorkingCopyMeta::from_json(&text).is_err(), "{encoding}");
    }
}

#[test]
fn signed_encoder_rejects_invalid_samples_dimensions_and_lengths() {
    for sample in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let invalid = LinearImage {
            width: 1,
            height: 1,
            data: vec![sample, 0.0, 0.0],
        };
        assert!(encode_signed_working_copy(&invalid).is_err());
    }
    let oversized = LinearImage {
        width: 1,
        height: 1,
        data: vec![65536.1, 0.0, 0.0],
    };
    assert!(encode_signed_working_copy(&oversized).is_err());
    let bad_dimensions = LinearImage {
        width: 0,
        height: 1,
        data: Vec::new(),
    };
    assert!(encode_signed_working_copy(&bad_dimensions).is_err());
    let bad_length = LinearImage {
        width: 1,
        height: 1,
        data: vec![0.0, 1.0],
    };
    assert!(encode_signed_working_copy(&bad_length).is_err());

    for value in [0.0, 65536.0, -65536.0] {
        let boundary = LinearImage {
            width: 1,
            height: 1,
            data: vec![value, 0.0, 0.0],
        };
        let (_, encoding) = encode_signed_working_copy(&boundary).unwrap();
        assert_eq!(encoding.ceiling(), if value == 0.0 { 1.0 } else { 65536.0 });
    }
}

#[test]
fn engine_look_pairs_fail_closed() {
    assert_eq!(
        parse_settings(r#"{"engine":"niho-3","look":"niho-interim-1"}"#)
            .unwrap_err()
            .to_string(),
        "invalid_settings: look (engineLookMismatch): niho-3 requires niho-standard-2, and niho-standard-2 requires niho-3"
    );
    assert!(parse_settings(r#"{"engine":"niho-2","look":"niho-standard-2"}"#).is_err());
    assert!(parse_settings(r#"{"engine":"niho-15"}"#).is_err());
    assert!(parse_settings(r#"{"engine":"niho-12","look":"niho-standard-2"}"#).is_err());
    assert!(parse_settings(r#"{"engine":"niho-13","look":"niho-standard-2"}"#).is_err());
    assert!(parse_settings(r#"{"engine":"niho-14","look":"niho-standard-2"}"#).is_err());
}

#[test]
fn xmp_cnr_reaches_rasters_through_detail_and_keeps_the_niho3_field() {
    let preset = xmp::builtin_preset("niho-colorful").unwrap().xmp;
    // Without a base (neutral niho-1, a raster engine) the preset's CNR 25
    // and Sharpness 40 render through v6 detail (Issue #32); the legacy
    // top-level field, which rasters ignore, stays untouched.
    let raster_result = xmp::preset_settings(preset, None).unwrap();
    let raster_cnr = raster_result
        .items
        .iter()
        .find(|item| item.property == "ColorNoiseReduction")
        .unwrap();
    assert_eq!(raster_cnr.level, xmp::Level::Approximate);
    assert_eq!(raster_cnr.photo_bench_level, xmp::Level::Unsupported);
    let raster = raster_result.settings;
    assert_eq!(raster.color_noise_reduction, 0.0);
    assert!(!raster
        .to_value()
        .as_object()
        .unwrap()
        .contains_key("colorNoiseReduction"));
    let detail = raster.detail.expect("v6 detail");
    assert_eq!(detail.color_noise_reduction, Some(25.0));
    assert_eq!(detail.sharpening.amount, 40.0);
    // colorful also turns on the chromatic aberration removal
    // (`AutoLateralCA`, niho-photo#45), which needs v 9.
    assert!(raster.lens.remove_chromatic_aberration);
    assert_eq!(raster.v, 9);

    let base = niho3();
    let result = xmp::preset_settings(preset, Some(&base)).unwrap();
    let cnr = result
        .items
        .iter()
        .find(|item| item.property == "ColorNoiseReduction")
        .unwrap();
    assert_eq!(cnr.level, xmp::Level::Approximate);
    assert_eq!(cnr.photo_bench_level, xmp::Level::Unsupported);
    // Camera Raw's default sub-controls (50) are the frozen CNR's own.
    for property in ["ColorNoiseReductionDetail", "ColorNoiseReductionSmoothness"] {
        let item = result
            .items
            .iter()
            .find(|item| item.property == property)
            .unwrap();
        assert_eq!(item.level, xmp::Level::Approximate);
        assert_eq!(item.photo_bench_level, xmp::Level::Unsupported);
    }
    let full = result.settings;
    assert_eq!(full.color_noise_reduction, 25.0);
    assert_eq!(full.color_noise_reduction_detail, 50.0);
    assert_eq!(full.color_noise_reduction_smoothness, 50.0);
    // Sharpening needs the detail object, which then owns the color amount
    // explicitly (0..50 is the same R209 operation).
    assert_eq!(full.detail.unwrap().color_noise_reduction, Some(25.0));
    let half = xmp::apply_preset(preset, &base, 0.5, None)
        .unwrap()
        .settings;
    assert_eq!(half.color_noise_reduction, 12.5);
    assert_eq!(half.detail.unwrap().color_noise_reduction, Some(12.5));
    assert_eq!(half.detail.unwrap().sharpening.amount, 20.0);
    assert_eq!(half.engine, ENGINE_NIHO_3);
    assert_eq!(half.look, LOOK_NIHO_STANDARD_2);

    // A signed-RAW preset with only R209's range keeps the old shape: no
    // detail object, no version bump, the same pixels as before.
    let cnr_only = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Sharpness="0" crs:LuminanceSmoothing="0" crs:ColorNoiseReduction="31"/></rdf:RDF></x:xmpmeta>"#;
    let kept = xmp::preset_settings(cnr_only, Some(&base))
        .unwrap()
        .settings;
    assert_eq!(kept.detail, None);
    assert_eq!(kept.color_noise_reduction, 31.0);
    assert_eq!(kept.v, base.v);
    // Above 50 the legacy field saturates, so the value moves into detail.
    let strong = cnr_only.replace("\"31\"", "\"80\"");
    let extended = xmp::preset_settings(&strong, Some(&base)).unwrap().settings;
    assert_eq!(extended.detail.unwrap().color_noise_reduction, Some(80.0));
    assert_eq!(extended.v, 6);
}

#[test]
fn session_reuses_full_master_and_invalidates_cnr_hs_texture() {
    let source = image(24, 18);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let ceiling = encoding.ceiling();
    let mut session =
        Session::open_working_copy(&png, &metadata(ceiling), Filter::Lanczos3).unwrap();
    let base = niho3();
    let first = session.render(&base, 0, Quality::Final).unwrap();
    let interactive = session.render(&base, 0, Quality::Interactive).unwrap();
    let interactive_fresh = Session::open_working_copy(&png, &metadata(ceiling), Filter::Lanczos3)
        .unwrap()
        .render(&base, 0, Quality::Interactive)
        .unwrap();
    assert_eq!(interactive.rgba, interactive_fresh.rgba);
    assert_eq!(
        first.rgba,
        session.render(&base, 0, Quality::Final).unwrap().rgba
    );

    let mut changed = base.clone();
    changed.color_noise_reduction = 25.0;
    changed.highlights = -40.0;
    changed.shadows = 35.0;
    changed.texture = 20.0;
    let changed_frame = session.render(&changed, 0, Quality::Final).unwrap();
    assert_ne!(first.rgba, changed_frame.rgba);
    let changed_fresh = Session::open_working_copy(&png, &metadata(ceiling), Filter::Lanczos3)
        .unwrap()
        .render(&changed, 0, Quality::Final)
        .unwrap();
    assert_eq!(changed_frame.rgba, changed_fresh.rgba);

    let mut wb_ev_texture = changed.clone();
    wb_ev_texture.highlights = -65.0;
    wb_ev_texture.shadows = 60.0;
    wb_ev_texture.exposure = 0.7;
    wb_ev_texture.texture = -25.0;
    wb_ev_texture.white_balance.mode = WhiteBalanceMode::Absolute;
    wb_ev_texture.white_balance.temperature = Some(6500.0);
    wb_ev_texture.white_balance.tint = Some(-8.0);
    let cached = session.render(&wb_ev_texture, 0, Quality::Final).unwrap();
    let fresh = Session::open_working_copy(&png, &metadata(ceiling), Filter::Lanczos3)
        .unwrap()
        .render(&wb_ev_texture, 0, Quality::Final)
        .unwrap();
    assert_eq!(cached.rgba, fresh.rgba);

    let mut plateau_50 = base.clone();
    plateau_50.color_noise_reduction = 50.0;
    let plateau_50 = session.render(&plateau_50, 0, Quality::Final).unwrap();
    let mut plateau_100 = base.clone();
    plateau_100.color_noise_reduction = 100.0;
    let plateau_100 = session.render(&plateau_100, 0, Quality::Final).unwrap();
    assert_eq!(plateau_50.rgba, plateau_100.rgba);

    let restored = session.render(&base, 0, Quality::Final).unwrap();
    assert_eq!(first.rgba, restored.rgba);

    // These controls live after the cached master and must use the current
    // frame's settings rather than the snapshot that created the master.
    let mut tail_only = base.clone();
    tail_only.highlights = 20.0;
    let positive_20 = session.render(&tail_only, 0, Quality::Final).unwrap();
    tail_only.highlights = 45.0;
    tail_only.color_noise_reduction_detail = 60.0;
    let positive_45 = session.render(&tail_only, 0, Quality::Final).unwrap();
    assert_ne!(positive_20.rgba, positive_45.rgba);
    assert!(positive_45
        .approximations
        .contains(&"colorNoiseReductionDetail"));

    let mut relative = base.clone();
    relative.white_balance.mode = WhiteBalanceMode::Relative;
    relative.relative_temperature = 30.0;
    relative.relative_tint = -15.0;
    let relative_frame = session.render(&relative, 0, Quality::Final).unwrap();
    assert_ne!(first.rgba, relative_frame.rgba);

    let mut crop = changed;
    crop.v = 2;
    crop.geometry = Some(
        niho_develop::Geometry::from_value(
            &serde_json::from_str(
                r#"{"rotate":90,"crop":{"left":0.1,"top":0.2,"right":0.8,"bottom":0.9}}"#,
            )
            .unwrap(),
        )
        .unwrap(),
    );
    let cropped = session.render(&crop, 12, Quality::Final).unwrap();
    assert!(cropped.width <= 12 && cropped.height <= 12);

    let independent = Session::open_working_copy(&png, &metadata(ceiling), Filter::Lanczos3)
        .unwrap()
        .render(&base, 0, Quality::Final)
        .unwrap();
    assert_eq!(first.rgba, independent.rgba);

    let options = RenderOptions {
        max_dimension: 0,
        quality: Quality::Final,
        filter: Filter::Lanczos3,
        ..RenderOptions::default()
    };
    let one_shot =
        render_working_copy(&png, &metadata(ceiling), &base.to_json(), &options).unwrap();
    assert_eq!(first.rgba, one_shot.rgba);
}

#[test]
fn same_session_tail_crop_and_effect_changes_match_fresh_sessions() {
    let source = image(32, 24);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let meta = metadata(encoding.ceiling());
    let base = niho3();
    let mut shared = Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    shared.render(&base, 0, Quality::Final).unwrap();

    let mut tail = base.clone();
    tail.contrast = 80.0;
    tail.hsl.set(
        HslBand::Blue,
        HslAdjustment {
            hue: 20.0,
            saturation: -30.0,
            luminance: 15.0,
        },
    );

    let mut crop = base.clone();
    crop.v = 2;
    crop.geometry = Some(
        niho_develop::Geometry::from_value(
            &serde_json::from_str(
                r#"{"rotate":90,"crop":{"left":0.1,"top":0.1,"right":0.85,"bottom":0.9}}"#,
            )
            .unwrap(),
        )
        .unwrap(),
    );

    let mut effects = base.clone();
    effects.v = 3;
    effects.vignette.amount = -45.0;
    effects.grain.amount = 30.0;
    effects.grain.seed = Some(17.0);

    for settings in [&tail, &crop, &effects] {
        let same = shared.render(settings, 0, Quality::Final).unwrap();
        let fresh = Session::open_working_copy(&png, &meta, Filter::Lanczos3)
            .unwrap()
            .render(settings, 0, Quality::Final)
            .unwrap();
        assert_eq!((same.width, same.height), (fresh.width, fresh.height));
        assert_eq!(same.rgba, fresh.rgba);
    }
}

#[test]
fn auto_uses_niho3_path_and_rejects_incompatible_working_copies() {
    let source = image(24, 18);
    let (signed, encoding) = encode_signed_working_copy(&source).unwrap();
    let meta = metadata(encoding.ceiling());
    let settings = niho3();
    let mut session = Session::open_working_copy(&signed, &meta, Filter::Lanczos3).unwrap();
    let before = session.render(&settings, 0, Quality::Final).unwrap();
    let outcome = session.auto_outcome(&settings).unwrap();
    assert!((1..=3).contains(&outcome.renders));
    let after = session.render(&settings, 0, Quality::Final).unwrap();
    assert_eq!(before.rgba, after.rgba, "auto must not alter parent caches");

    let mut signed_old = Session::open_working_copy(&signed, &meta, Filter::Lanczos3).unwrap();
    assert!(matches!(
        signed_old.auto_outcome(&DevelopSettings::neutral()),
        Err(Error::IncompatibleWorkingCopy(_))
    ));

    let unsigned = niho_develop::decode::encode_working_copy(&source);
    let unsigned_meta = meta.replace(
        &format!(
            r#","encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}"#,
            encoding.ceiling()
        ),
        "",
    );
    let mut unsigned_new =
        Session::open_working_copy(&unsigned, &unsigned_meta, Filter::Lanczos3).unwrap();
    assert!(matches!(
        unsigned_new.auto_outcome(&settings),
        Err(Error::IncompatibleWorkingCopy(_))
    ));
}

#[test]
fn signed_thumbnail_keeps_full_source_for_canonical_analysis() {
    let source = image(48, 36);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let meta = metadata(encoding.ceiling());
    let mut settings = niho3();
    settings.color_noise_reduction = 31.0;
    settings.highlights = -37.0;
    settings.shadows = 42.0;
    settings.texture = 18.0;

    let mut full = Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    let expected = full.render(&settings, 12, Quality::Final).unwrap();
    let mut thumbnail = full.thumbnail(12);
    assert_eq!(thumbnail.source_size(), (48, 36));
    let actual = thumbnail.render(&settings, 0, Quality::Final).unwrap();
    assert_eq!(actual.rgba, expected.rgba);

    let expected_interactive = Session::open_working_copy(&png, &meta, Filter::Lanczos3)
        .unwrap()
        .render(&settings, 12, Quality::Interactive)
        .unwrap();
    let actual_interactive = thumbnail
        .render(&settings, 0, Quality::Interactive)
        .unwrap();
    assert_eq!(
        (actual_interactive.width, actual_interactive.height),
        (12, 9)
    );
    assert_eq!(actual_interactive.rgba, expected_interactive.rgba);
}

/// A signed thumbnail and an auto run start from the parent's analysis
/// (#17945): the same frames and settings as from a session that never
/// rendered, at the parent's CNR amount and at another one, and the
/// parent's later frames are unchanged.
#[test]
fn thumbnail_and_auto_share_the_parent_analysis_with_identical_results() {
    let source = image(64, 48);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let meta = metadata(encoding.ceiling());
    let open = || Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    let mut photo = niho3();
    photo.color_noise_reduction = 25.0;
    photo.highlights = -40.0;
    photo.shadows = 30.0;

    let mut parent = open();
    parent.render(&photo, 20, Quality::Final).unwrap();
    parent.render(&photo, 20, Quality::Interactive).unwrap();
    let mut shared = parent.thumbnail(32);
    let mut unshared = open().thumbnail(32);
    let mut other_cnr = photo.clone();
    other_cnr.color_noise_reduction = 0.0;
    other_cnr.highlights = -60.0;
    let mut texture = photo.clone();
    texture.texture = 20.0;
    texture.exposure = 0.4;
    for settings in [&photo, &other_cnr, &texture, &photo] {
        for quality in [Quality::Final, Quality::Interactive] {
            let same = shared.render(settings, 0, quality).unwrap();
            let fresh = unshared.render(settings, 0, quality).unwrap();
            assert_eq!((same.width, same.height), (fresh.width, fresh.height));
            assert_eq!(same.rgba, fresh.rgba, "{quality:?}");
        }
    }

    for settings in [&photo, &other_cnr] {
        assert_eq!(
            parent.auto_settings(settings).unwrap(),
            open().auto_settings(settings).unwrap()
        );
    }
    let after = parent.render(&photo, 20, Quality::Final).unwrap();
    assert_eq!(
        after.rgba,
        open().render(&photo, 20, Quality::Final).unwrap().rgba
    );

    // A parent without coefficients (no H/S): the ones a thumbnail computes
    // serve auto and the parent's own later Highlights.
    let neutral = niho3();
    let mut parent = open();
    parent.render(&neutral, 20, Quality::Final).unwrap();
    let mut shared = parent.thumbnail(32);
    let mut unshared = open().thumbnail(32);
    assert_eq!(
        shared.render(&other_cnr, 0, Quality::Final).unwrap().rgba,
        unshared.render(&other_cnr, 0, Quality::Final).unwrap().rgba
    );
    assert_eq!(
        parent.auto_settings(&neutral).unwrap(),
        open().auto_settings(&neutral).unwrap()
    );
    assert_eq!(
        parent.render(&other_cnr, 20, Quality::Final).unwrap().rgba,
        open().render(&other_cnr, 20, Quality::Final).unwrap().rgba
    );
}

#[test]
fn interactive_preparation_switches_sizes_without_poisoning_final() {
    let source = image(64, 48);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let meta = metadata(encoding.ceiling());
    let mut settings = niho3();
    settings.color_noise_reduction = 31.0;
    settings.highlights = -47.0;
    settings.shadows = 38.0;
    settings.exposure = 0.45;
    settings.texture = 21.0;
    settings.white_balance.mode = WhiteBalanceMode::Absolute;
    settings.white_balance.temperature = Some(4700.0);
    settings.white_balance.tint = Some(9.0);

    let mut session = Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    let final_before = session.render(&settings, 19, Quality::Final).unwrap();
    for max_dimension in [0, 16, 80, 12, 16] {
        let cached = session
            .render(&settings, max_dimension, Quality::Interactive)
            .unwrap();
        let fresh = Session::open_working_copy(&png, &meta, Filter::Lanczos3)
            .unwrap()
            .render(&settings, max_dimension, Quality::Interactive)
            .unwrap();
        assert_eq!(
            (cached.width, cached.height),
            (fresh.width, fresh.height),
            "max {max_dimension}"
        );
        assert_eq!(cached.rgba, fresh.rgba, "max {max_dimension}");
    }
    let final_after = session.render(&settings, 19, Quality::Final).unwrap();
    assert_eq!(final_after.rgba, final_before.rgba);
}

/// The editor's drag cycle (#17945): Final, Interactive frames on the
/// display-size master, Final again. Releasing a tail slider takes back the
/// parked full-source master; moving a master input prepares a new one.
/// Every frame equals a fresh session's.
#[test]
fn released_drags_match_fresh_sessions_with_the_parked_master() {
    let source = image(64, 48);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let meta = metadata(encoding.ceiling());
    let fresh = |settings: &DevelopSettings, max_dimension: usize, quality: Quality| {
        Session::open_working_copy(&png, &meta, Filter::Lanczos3)
            .unwrap()
            .render(settings, max_dimension, quality)
            .unwrap()
    };
    let mut settings = niho3();
    settings.color_noise_reduction = 20.0;
    settings.highlights = -40.0;
    settings.shadows = 30.0;
    settings.texture = 15.0;
    settings.white_balance.mode = WhiteBalanceMode::Absolute;
    settings.white_balance.temperature = Some(5200.0);
    settings.white_balance.tint = Some(6.0);

    let mut session = Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    let mut check = |settings: &DevelopSettings, max_dimension: usize, quality: Quality| {
        let same = session.render(settings, max_dimension, quality).unwrap();
        let expected = fresh(settings, max_dimension, quality);
        assert_eq!(
            (same.width, same.height),
            (expected.width, expected.height),
            "{max_dimension} {quality:?}"
        );
        assert_eq!(same.rgba, expected.rgba, "{max_dimension} {quality:?}");
        same.rgba
    };
    let first = check(&settings, 20, Quality::Final);

    let mut tail = settings.clone();
    for contrast in [5.0, 10.0, 15.0] {
        tail.contrast = contrast;
        check(&tail, 20, Quality::Interactive);
    }
    check(&tail, 20, Quality::Final);
    check(&tail, 0, Quality::Final);
    tail.vibrance = 12.0;
    check(&tail, 16, Quality::Interactive);
    check(&tail, 0, Quality::Final);
    check(
        &with_geometry(
            &tail,
            r#"{"crop":{"left":0.1,"top":0,"right":0.8,"bottom":1}}"#,
        ),
        20,
        Quality::Final,
    );
    tail.saturation = -8.0;
    check(&tail, 20, Quality::Interactive);
    check(&tail, 20, Quality::Final);

    let mut master = tail.clone();
    for highlights in [-45.0, -50.0] {
        master.highlights = highlights;
        check(&master, 20, Quality::Interactive);
    }
    check(&master, 20, Quality::Final);
    master.exposure = 0.3;
    check(&master, 20, Quality::Interactive);
    master.color_noise_reduction = 35.0;
    check(&master, 20, Quality::Interactive);
    check(&master, 20, Quality::Final);
    check(&master, 0, Quality::Final);

    assert_eq!(check(&settings, 20, Quality::Final), first);
}

#[test]
fn interactive_geometry_keeps_full_preparation_and_separate_frame_caches() {
    let source = image(64, 48);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let meta = metadata(encoding.ceiling());
    let mut base = niho3();
    base.color_noise_reduction = 28.0;
    base.highlights = -42.0;
    base.shadows = 36.0;
    base.exposure = 0.35;
    base.texture = -19.0;

    let cases = [
        r#"{"crop":{"left":0.15,"top":0.1,"right":0.8,"bottom":0.9}}"#,
        r#"{"rotate":90}"#,
        r#"{"rotate":90,"angle":3,"crop":{"left":0.1,"top":0.15,"right":0.85,"bottom":0.9}}"#,
    ];
    let mut shared = Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    for geometry in cases {
        let settings = with_geometry(&base, geometry);
        let first = shared.render(&settings, 18, Quality::Interactive).unwrap();
        let fresh = Session::open_working_copy(&png, &meta, Filter::Lanczos3)
            .unwrap()
            .render(&settings, 18, Quality::Interactive)
            .unwrap();
        let final_frame = Session::open_working_copy(&png, &meta, Filter::Lanczos3)
            .unwrap()
            .render(&settings, 18, Quality::Final)
            .unwrap();
        assert_eq!((first.width, first.height), (fresh.width, fresh.height));
        assert_eq!(first.rgba, fresh.rgba, "{geometry}");
        assert_eq!(
            (first.width, first.height),
            (final_frame.width, final_frame.height),
            "{geometry}"
        );

        shared.render(&base, 18, Quality::Interactive).unwrap();
        let restored = shared.render(&settings, 18, Quality::Interactive).unwrap();
        assert_eq!(restored.rgba, first.rgba, "{geometry}");
    }
}

#[test]
fn source_encoding_cannot_be_silently_misinterpreted() {
    let source = image(4, 3);
    let (signed, encoding) = encode_signed_working_copy(&source).unwrap();
    let mut signed_session =
        Session::open_working_copy(&signed, &metadata(encoding.ceiling()), Filter::Lanczos3)
            .unwrap();
    let old = DevelopSettings::neutral();
    assert!(matches!(
        signed_session.render(&old, 0, Quality::Final),
        Err(Error::IncompatibleWorkingCopy(_))
    ));

    let unsigned = niho_develop::decode::encode_working_copy(&source);
    let unsigned_meta = metadata(encoding.ceiling()).replace(
        &format!(
            r#","encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}"#,
            encoding.ceiling()
        ),
        "",
    );
    let mut unsigned_session =
        Session::open_working_copy(&unsigned, &unsigned_meta, Filter::Lanczos3).unwrap();
    assert!(matches!(
        unsigned_session.render(&niho3(), 0, Quality::Final),
        Err(Error::IncompatibleWorkingCopy(_))
    ));
}

#[test]
fn raster_niho3_inherits_the_niho2_path() {
    let mut rgba = Vec::new();
    for index in 0..12 * 8 {
        rgba.extend_from_slice(&[
            (index * 17) as u8,
            (index * 29) as u8,
            (index * 43) as u8,
            255,
        ]);
    }
    let png = encode::encode_png(&rgba, 12, 8).unwrap();
    let mut old = DevelopSettings::neutral();
    old.engine = ENGINE_NIHO_2.into();
    old.look = LOOK_NIHO_INTERIM_1.into();
    old.blacks = 60.0;
    old.vibrance = 35.0;
    let mut new = old.clone();
    new.engine = ENGINE_NIHO_3.into();
    new.look = LOOK_NIHO_STANDARD_2.into();
    for quality in [Quality::Final, Quality::Interactive] {
        let old_frame = Session::open_raster(&png, 0, Filter::Lanczos3)
            .unwrap()
            .render(&old, 0, quality)
            .unwrap();
        let new_frame = Session::open_raster(&png, 0, Filter::Lanczos3)
            .unwrap()
            .render(&new, 0, quality)
            .unwrap();
        assert_eq!(old_frame.rgba, new_frame.rgba, "{quality:?}");
    }

    new.color_noise_reduction_detail = 65.0;
    new.color_noise_reduction_smoothness = 35.0;
    let report = Session::open_raster(&png, 0, Filter::Lanczos3)
        .unwrap()
        .render(&new, 0, Quality::Final)
        .unwrap();
    assert!(report.approximations.contains(&"colorNoiseReductionDetail"));
    assert!(report
        .approximations
        .contains(&"colorNoiseReductionSmoothness"));
}

#[test]
fn interactive_master_changes_reuse_only_matching_cubes() {
    let source = image(40, 30);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let meta = metadata(encoding.ceiling());
    let mut session = Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    let mut settings = niho3();
    settings.highlights = -30.0;
    settings.shadows = 20.0;
    settings.contrast = 15.0;
    settings.vibrance = 30.0;
    let initial = session.render(&settings, 20, Quality::Final).unwrap();
    let original = settings.clone();
    for change in 0..7 {
        match change {
            0 => {
                settings.highlights = -60.0;
                settings.shadows = 55.0;
            }
            1 => {
                settings.white_balance.mode = WhiteBalanceMode::Absolute;
                settings.white_balance.temperature = Some(4300.0);
                settings.white_balance.tint = Some(12.0);
            }
            2 => settings.exposure = 0.6,
            3 => settings.texture = -25.0,
            4 => settings.color_noise_reduction = 35.0,
            5 => settings.contrast = 35.0,
            _ => settings.vibrance = 65.0,
        }
        let cached = session.render(&settings, 20, Quality::Interactive).unwrap();
        let fresh = Session::open_working_copy(&png, &meta, Filter::Lanczos3)
            .unwrap()
            .render(&settings, 20, Quality::Interactive)
            .unwrap();
        assert_eq!(cached.rgba, fresh.rgba, "change {change}");
    }
    let restored = session.render(&original, 20, Quality::Final).unwrap();
    assert_eq!(initial.rgba, restored.rgba);
}
