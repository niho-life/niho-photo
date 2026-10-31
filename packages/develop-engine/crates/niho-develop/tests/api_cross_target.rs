//! `niho_develop::api` (the calls the browser's wasm and the Mac's
//! `niho-develop-render serve` both wrap, #152) gives the same pixels,
//! bytes and JSON natively and in browser wasm. This test runs on both
//! targets and pins the SHA-256 of each result for the inputs of
//! `api_fixture` (a synthetic photo under a geometry and local masks, a
//! synthetic 16-bit working copy); `niho-develop-render`'s `tests/serve.rs`
//! pins the sidecar's answers to the same digests.

mod api_fixture;

use api_fixture as f;
use niho_develop::api::{self, Developer};

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_give_the_same_api_results() {
    let photo = f::photo_png();
    let mut actual: Vec<(&str, String)> = Vec::new();

    let frame = api::render(&photo, f::SETTINGS, f::MAX_DIMENSION, None).unwrap();
    actual.push(("render", f::sha256(&frame.rgba)));
    actual.push((
        "render.size",
        f::size_text(frame.width as u64, frame.height as u64),
    ));
    actual.push(("render.approximations", frame.approximations.join(",")));
    let jpeg =
        api::export_jpeg(&photo, f::SETTINGS, f::MAX_DIMENSION, f::JPEG_QUALITY, None).unwrap();
    actual.push(("exportJpeg", f::sha256(&jpeg)));
    let png = api::export_png(&photo, f::SETTINGS, f::MAX_DIMENSION, None).unwrap();
    actual.push(("exportPng", f::sha256(&png)));
    let dated = api::with_capture_exif(&jpeg, Some(f::CAPTURED_AT), f::OFFSET_MINUTES).unwrap();
    actual.push(("withCaptureExif", f::sha256(&dated)));
    let size = api::image_size(&photo).unwrap();
    actual.push((
        "imageSize",
        f::size_text(size.width.into(), size.height.into()),
    ));

    let mut developer = Developer::new(&photo, 0).unwrap();
    actual.push((
        "Developer.new.size",
        f::size_text(developer.width().into(), developer.height().into()),
    ));
    let drag = developer
        .render(f::SETTINGS, f::MAX_DIMENSION, true)
        .unwrap();
    actual.push(("Developer.render.interactive", f::sha256(&drag.rgba)));
    let released = developer
        .render(f::SETTINGS, f::MAX_DIMENSION, false)
        .unwrap();
    actual.push(("Developer.render.final", f::sha256(&released.rgba)));
    actual.push((
        "Developer.render.size",
        f::size_text(released.width as u64, released.height as u64),
    ));
    let plane = developer
        .mask_plane(f::SETTINGS, f::MASK_ID, f::MAX_DIMENSION)
        .unwrap();
    actual.push(("Developer.maskPlane", f::sha256(&plane.data)));
    actual.push((
        "Developer.maskPlane.size",
        f::size_text(plane.width.into(), plane.height.into()),
    ));
    let color = developer
        .sample_color(f::SETTINGS, f::MAX_DIMENSION, f::SAMPLE_X, f::SAMPLE_Y)
        .unwrap();
    actual.push((
        "Developer.sampleColor",
        f::color_digest(color.lightness, color.chroma, color.hue),
    ));
    let auto = developer.auto_settings(f::SETTINGS).unwrap();
    actual.push(("Developer.autoSettings", f::sha256(auto.as_bytes())));
    let upright = developer
        .estimate_upright(f::SETTINGS, f::UPRIGHT_MODE)
        .unwrap();
    actual.push(("Developer.estimateUpright", f::sha256(upright.as_bytes())));
    let (layout, weights) = f::sky_model();
    actual.push((
        "setSkyModel",
        api::set_sky_model(&layout, &weights).unwrap(),
    ));
    let sky = developer
        .detect_sky(f::SETTINGS, None)
        .unwrap()
        .expect("sky");
    actual.push(("Developer.detectSky", f::sha256(&sky.png)));
    actual.push((
        "Developer.detectSky.size",
        f::size_text(sky.width.into(), sky.height.into()),
    ));
    let mut thumbnail = developer.thumbnail(f::THUMBNAIL_MAX_DIMENSION);
    let small = thumbnail.render(f::SETTINGS, 0, false).unwrap();
    actual.push(("Developer.thumbnail.render", f::sha256(&small.rgba)));

    let mut working =
        Developer::open_working_copy(&f::working_copy(), f::WORKING_COPY_META).unwrap();
    let as_shot = working.as_shot_white();
    assert_eq!(
        api::as_shot_white_from_meta(f::WORKING_COPY_META).unwrap(),
        as_shot
    );
    actual.push(("Developer.asShotWhite", as_shot.clone()));
    let developed = working.render(f::WORKING_COPY_SETTINGS, 0, false).unwrap();
    actual.push((
        "Developer.openWorkingCopy.render",
        f::sha256(&developed.rgba),
    ));

    let xmp = f::preset_xmp();
    let preset = api::preset_settings(xmp, None).unwrap();
    actual.push(("presetSettings", f::sha256(preset.as_bytes())));
    let applied = api::apply_preset(
        xmp,
        f::WORKING_COPY_SETTINGS,
        f::PRESET_AMOUNT,
        Some(&as_shot),
    )
    .unwrap();
    actual.push(("applyPreset", f::sha256(applied.as_bytes())));
    let written = api::settings_to_xmp(f::SETTINGS, Some(f::XMP_OPTIONS)).unwrap();
    actual.push(("settingsToXmp", f::sha256(written.as_bytes())));
    let issues = api::validate_settings(f::INVALID_SETTINGS);
    assert_ne!(issues, "[]");
    actual.push(("validateSettings", f::sha256(issues.as_bytes())));
    let converted = api::convert_edit_settings(f::EDIT_SETTINGS, Some(f::CONVERT_BASE)).unwrap();
    actual.push(("convertEditSettings", f::sha256(converted.as_bytes())));

    f::assert_expected(&actual);
}

/// The calls that only shape their answers agree with the crate's own
/// functions.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_shaping_calls_agree_with_the_crate() {
    let photo = f::photo_png();
    assert_eq!(
        api::version(),
        format!(
            "niho-develop {} (engine {})",
            niho_develop::CRATE_VERSION,
            niho_develop::ENGINE_VERSION
        )
    );
    let settings = niho_develop::parse_settings(f::SETTINGS).unwrap();
    let decode = api::raster_decode_size(f::SETTINGS, 160, 120, f::MAX_DIMENSION, 0).unwrap();
    assert_eq!(
        decode as usize,
        niho_develop::raster_decode_size(&settings, 160, 120, f::MAX_DIMENSION as usize, 0)
            .unwrap()
    );
    let output = api::geometry_output_size(f::SETTINGS, 160, 120, f::MAX_DIMENSION).unwrap();
    let frame = api::render(&photo, f::SETTINGS, f::MAX_DIMENSION, None).unwrap();
    assert_eq!(
        (output.width as usize, output.height as usize),
        (frame.width, frame.height)
    );
    assert_eq!(
        api::before_settings(f::SETTINGS).unwrap(),
        niho_develop::before_settings(f::SETTINGS).unwrap()
    );
    assert_eq!(
        api::neutral_settings(),
        niho_develop::DevelopSettings::new_edit().to_json()
    );
    let presets: serde_json::Value = serde_json::from_str(&api::builtin_presets()).unwrap();
    assert_eq!(presets[0]["xmp"], f::preset_xmp());
    assert_eq!(
        api::render(&photo, "{", f::MAX_DIMENSION, None)
            .err()
            .unwrap(),
        niho_develop::parse_settings("{").err().unwrap().to_string()
    );
}
