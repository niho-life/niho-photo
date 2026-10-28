//! End-to-end behaviour of the render pipeline (runs in CI).

use niho_develop::decode::{self, LinearImage};
use niho_develop::settings::{WhiteBalance, WhiteBalanceMode};
use niho_develop::{xmp, DevelopSettings, Filter, Quality, RenderOptions, Session};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn bluesky2() -> DevelopSettings {
    xmp::preset_settings(xmp::builtin_preset("niho-bluesky2").unwrap().xmp, None)
        .unwrap()
        .settings
}

#[test]
fn exif_orientation_is_applied_to_pixels() {
    let raster =
        decode::decode_raster(&fixture("golden/orientation-6.jpg"), 0, Filter::Lanczos3).unwrap();
    assert_eq!((raster.image.width, raster.image.height), (48, 64));
    assert!(raster.info.orientation_applied);
    // Rotate 90° CW: the new top-left comes from the original bottom-left
    // (left half red, bottom half without blue).
    let px = &raster.image.data[0..3];
    assert!(px[0] > 0.8 && px[2] < 0.05, "{px:?}");
}

#[test]
fn neutral_render_of_a_bounded_srgb_png_is_lossless() {
    let mut rgb = Vec::new();
    for i in 0..(97 * 61) {
        rgb.extend_from_slice(&[
            (i % 256) as u8,
            ((i * 7) % 256) as u8,
            ((i * 13) % 256) as u8,
        ]);
    }
    let img = image::RgbImage::from_raw(97, 61, rgb.clone()).unwrap();
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let frame = niho_develop::render(
        &png,
        "{}",
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap();
    let back: Vec<u8> = frame
        .rgba
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    assert_eq!(back, rgb);
}

#[test]
fn render_is_deterministic_and_matches_the_session() {
    let input = fixture("golden/input/dsc02150.jpg");
    let settings = bluesky2();
    let options = RenderOptions {
        max_dimension: 600,
        ..Default::default()
    };
    let a = niho_develop::render(&input, &settings.to_json(), &options).unwrap();
    let b = niho_develop::render(&input, &settings.to_json(), &options).unwrap();
    assert_eq!(a.rgba, b.rgba);
    assert_eq!((a.width, a.height), (600, 400));
    let mut session = Session::open_raster(&input, 600, Filter::Lanczos3).unwrap();
    let c = session.render(&settings, 600, Quality::Final).unwrap();
    assert_eq!(a.rgba, c.rgba);
    // A second frame reuses the statistics and cubes: same pixels.
    let d = session.render(&settings, 600, Quality::Final).unwrap();
    assert_eq!(c.rgba, d.rgba);
    let interactive = session
        .render(&settings, 300, Quality::Interactive)
        .unwrap();
    assert_eq!((interactive.width, interactive.height), (300, 200));
}

#[test]
fn invalid_settings_are_rejected() {
    let input = fixture("golden/input/dsc02150.jpg");
    let options = RenderOptions::default();
    let err = niho_develop::render(&input, r#"{"contrast": 150}"#, &options).unwrap_err();
    assert!(err.to_string().contains("contrast"), "{err}");
    let err = niho_develop::render(&input, r#"{"engine": "niho99"}"#, &options).unwrap_err();
    assert!(err.to_string().contains("unsupportedEngine"), "{err}");
    let err = niho_develop::render(b"not an image", "{}", &options).unwrap_err();
    assert!(err.to_string().starts_with("decode_failed"), "{err}");
}

fn working_copy() -> Vec<u8> {
    // A smooth linear ProPhoto ramp with a bright corner above 1.0.
    let (w, h) = (160usize, 120usize);
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let t = x as f32 / (w - 1) as f32;
            let u = y as f32 / (h - 1) as f32;
            data.extend_from_slice(&[
                0.02 + 0.9 * t * t,
                0.03 + 0.5 * u,
                0.05 + 0.3 * (1.0 - t) + if x > 150 { 1.2 } else { 0.0 },
            ]);
        }
    }
    decode::encode_working_copy(&LinearImage {
        width: w,
        height: h,
        data,
    })
}

const RAW_META: &str = r#"{"kind":"raw","baselineEV":0.35,"asShotWhite":{"x":0.3324,"y":0.3474,"temperature":5400,"tint":4},"dcpSha256":"test","lookTableIncluded":true}"#;

#[test]
fn working_copy_round_trips_and_renders_the_raw_path() {
    let png = working_copy();
    let decoded = decode::decode_working_copy(&png, 0, Filter::Lanczos3).unwrap();
    assert_eq!((decoded.width, decoded.height), (160, 120));
    assert!((decoded.data[0] - 0.02).abs() < 1e-4);
    let mut session = Session::open_working_copy(&png, RAW_META, Filter::Lanczos3).unwrap();
    let neutral = session
        .render(&DevelopSettings::neutral(), 0, Quality::Final)
        .unwrap();
    assert_eq!((neutral.width, neutral.height), (160, 120));
    assert!(neutral.approximations.contains(&"dcpLookTableNotApplied"));
    let mut warm = bluesky2();
    warm.white_balance = WhiteBalance {
        mode: WhiteBalanceMode::Absolute,
        temperature: Some(4200.0),
        tint: Some(8.0),
    };
    let edited = session.render(&warm, 80, Quality::Final).unwrap();
    assert_eq!((edited.width, edited.height), (80, 60));
    assert!(edited.approximations.contains(&"absoluteWhiteBalance"));
    // Lower Kelvin cools the picture: blue rises relative to red.
    let blue_minus_red = |f: &niho_develop::Rendered| -> i64 {
        f.rgba
            .chunks_exact(4)
            .map(|p| p[2] as i64 - p[0] as i64)
            .sum()
    };
    let as_shot = session.render(&bluesky2(), 80, Quality::Final).unwrap();
    assert!(blue_minus_red(&edited) > blue_minus_red(&as_shot));
}

#[test]
fn raw_drag_rebuilds_the_local_pass_after_spatial_adjustments_were_disabled() {
    let png = working_copy();
    let mut session = Session::open_working_copy(&png, RAW_META, Filter::Lanczos3).unwrap();

    let mut with_spatial = DevelopSettings::neutral();
    with_spatial.shadows = 50.0;
    session.render(&with_spatial, 0, Quality::Final).unwrap();

    let mut without_spatial = DevelopSettings::neutral();
    without_spatial.contrast = 45.0;
    session.render(&without_spatial, 0, Quality::Final).unwrap();

    let mut resumed_drag = without_spatial;
    resumed_drag.shadows = 50.0;
    let actual = session
        .render(&resumed_drag, 0, Quality::Interactive)
        .unwrap();
    let expected = Session::open_working_copy(&png, RAW_META, Filter::Lanczos3)
        .unwrap()
        .render(&resumed_drag, 0, Quality::Interactive)
        .unwrap();

    assert_eq!(actual.rgba, expected.rgba);
}

#[test]
fn working_copy_metadata_is_validated() {
    assert!(niho_develop::WorkingCopyMeta::from_json(
        r#"{"kind":"raw","asShotWhite":{"x":0.3,"y":0.3}}"#
    )
    .is_err());
    assert!(
        niho_develop::WorkingCopyMeta::from_json(r#"{"kind":"raster","iccSha256":"sRGB"}"#).is_ok()
    );
    assert!(niho_develop::WorkingCopyMeta::from_json(r#"{"kind":"dng"}"#).is_err());
}

mod common;

/// Spec "段 2": renders at different output sizes differ (the local
/// processing radius follows the long edge); compared at a common size the
/// mean ΔE00 must stay <= 1.0.
#[test]
fn different_output_sizes_agree_after_reduction() {
    let input = fixture("golden/input/dsc02078.jpg");
    let settings = bluesky2();
    let full = niho_develop::render(
        &input,
        &settings.to_json(),
        &RenderOptions {
            max_dimension: 1200,
            ..Default::default()
        },
    )
    .unwrap();
    let small = niho_develop::render(
        &input,
        &settings.to_json(),
        &RenderOptions {
            max_dimension: 600,
            ..Default::default()
        },
    )
    .unwrap();
    // Reduce the 1200px frame to 600px in linear light.
    let lin: Vec<f32> = full
        .rgba
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .map(|v| niho_develop::color::srgb_eotf(v as f64 / 255.0) as f32)
        .collect();
    let reduced = niho_develop::resize::resample(&lin, 1200, 800, 600, 400, Filter::Lanczos3);
    let mut sum = 0.0;
    for (i, px) in small.rgba.chunks_exact(4).enumerate() {
        let r = &reduced[i * 3..i * 3 + 3];
        let enc = |v: f32| niho_develop::output::encode_srgb8(v);
        let a = common::srgb_to_lab([px[0], px[1], px[2]]);
        let b = common::srgb_to_lab([enc(r[0]), enc(r[1]), enc(r[2])]);
        sum += common::delta_e00(a, b);
    }
    let mean = sum / (600.0 * 400.0);
    eprintln!("1200px vs 600px (at 600px): mean ΔE00 {mean:.3}");
    assert!(mean <= 1.0, "mean ΔE00 {mean}");
}

fn png_with_profile(pixels: &[u8], width: u32, icc: Option<Vec<u8>>) -> Vec<u8> {
    use image::ImageEncoder;
    let mut png = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut png);
    if let Some(icc) = icc {
        encoder.set_icc_profile(icc).unwrap();
    }
    encoder
        .write_image(pixels, width, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    png
}

#[test]
fn embedded_icc_profiles_are_converted_to_the_working_space() {
    let pixels = [255, 0, 0, 128, 128, 128, 255, 255, 255];
    // Display P3: pure red lies outside sRGB (extended linear sRGB keeps it).
    let p3 = moxcms::ColorProfile::new_display_p3().encode().unwrap();
    let raster =
        decode::decode_raster(&png_with_profile(&pixels, 3, Some(p3)), 0, Filter::Lanczos3)
            .unwrap();
    assert_eq!(raster.info.color, decode::ColorSource::IccMatrixShaper);
    let d = &raster.image.data;
    assert!(
        d[0] > 1.15 && d[1] < -0.02 && d[2] < -0.005,
        "P3 red {:?}",
        &d[0..3]
    );
    let gray = niho_develop::color::srgb_eotf(128.0 / 255.0) as f32;
    for c in 3..6 {
        assert!((d[c] - gray).abs() < 2e-3, "P3 gray {:?}", &d[3..6]);
    }
    for c in 6..9 {
        assert!((d[c] - 1.0).abs() < 2e-3, "P3 white {:?}", &d[6..9]);
    }
    // An embedded sRGB profile is the plain sRGB path (bounded raster).
    let srgb = moxcms::ColorProfile::new_srgb().encode().unwrap();
    let raster = decode::decode_raster(
        &png_with_profile(&pixels, 3, Some(srgb)),
        0,
        Filter::Lanczos3,
    )
    .unwrap();
    assert_eq!(
        raster.info.color,
        decode::ColorSource::Srgb { tagged: true }
    );
    assert!(raster.info.is_bounded_srgb());
    // No profile: sRGB.
    let raster =
        decode::decode_raster(&png_with_profile(&pixels, 3, None), 0, Filter::Lanczos3).unwrap();
    assert_eq!(
        raster.info.color,
        decode::ColorSource::Srgb { tagged: false }
    );
}

/// A LUT-only RGB profile (input class, PCS XYZ): `a2b0` / `a2b1` are
/// linear RGB -> XYZ (D50) matrices sampled into lutAtoB tables behind the
/// sRGB curve.
fn lut_profile(a2b0: Option<[[f64; 3]; 3]>, a2b1: Option<[[f64; 3]; 3]>) -> Vec<u8> {
    use moxcms::{LutMultidimensionalType, LutStore, LutWarehouse, ToneReprCurve};
    const GRID: usize = 9;
    let mab = |m: [[f64; 3]; 3]| {
        let step = |i: usize| i as f64 / (GRID - 1) as f64;
        let mut clut = Vec::new();
        for r in 0..GRID {
            for g in 0..GRID {
                for b in 0..GRID {
                    let rgb = [step(r), step(g), step(b)];
                    for row in m {
                        let v = row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2];
                        clut.push((v * 32768.0).round().clamp(0.0, 65535.0) as u16);
                    }
                }
            }
        }
        let srgb =
            ToneReprCurve::Parametric(vec![2.4, 1.0 / 1.055, 0.055 / 1.055, 1.0 / 12.92, 0.04045]);
        let mut grid_points = [0u8; 16];
        grid_points[..3].fill(GRID as u8);
        LutWarehouse::Multidimensional(LutMultidimensionalType {
            num_input_channels: 3,
            num_output_channels: 3,
            grid_points,
            clut: Some(LutStore::Store16(clut)),
            a_curves: vec![srgb; 3],
            b_curves: vec![ToneReprCurve::Lut(Vec::new()); 3],
            m_curves: Vec::new(),
            matrix: moxcms::Matrix3d::IDENTITY,
            bias: moxcms::Vector3d::default(),
        })
    };
    let mut profile = moxcms::ColorProfile::new_display_p3();
    profile.red_colorant = Default::default();
    profile.green_colorant = Default::default();
    profile.blue_colorant = Default::default();
    profile.red_trc = None;
    profile.green_trc = None;
    profile.blue_trc = None;
    profile.cicp = None;
    profile.chromatic_adaptation = None;
    profile.profile_class = moxcms::ProfileClass::InputDevice;
    profile.pcs = moxcms::DataColorSpace::Xyz;
    profile.lut_a_to_b_perceptual = a2b0.map(mab);
    profile.lut_a_to_b_colorimetric = a2b1.map(mab);
    profile.encode().unwrap()
}

/// Display P3 / Rec. 2020 linear RGB -> XYZ (D50, Bradford-adapted).
const P3_TO_XYZ_D50: [[f64; 3]; 3] = [
    [0.515102, 0.291965, 0.157153],
    [0.241182, 0.692236, 0.066582],
    [-0.001050, 0.041882, 0.784378],
];
const REC2020_TO_XYZ_D50: [[f64; 3]; 3] = [
    [0.673459, 0.165661, 0.125100],
    [0.279033, 0.675338, 0.045629],
    [-0.001931, 0.029979, 0.797162],
];

#[test]
fn lut_icc_profiles_are_converted_to_the_working_space() {
    // Primaries, a mid gray, a dark and a mixed color.
    let pixels = [
        255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128, 20, 30, 40, 200, 90, 30,
    ];
    let decode = |icc: Vec<u8>| {
        decode::decode_raster(
            &png_with_profile(&pixels, 6, Some(icc)),
            0,
            Filter::Lanczos3,
        )
    };
    let matrix = decode(moxcms::ColorProfile::new_display_p3().encode().unwrap()).unwrap();
    let lut = decode(lut_profile(Some(P3_TO_XYZ_D50), None)).unwrap();
    assert_eq!(lut.info.color, decode::ColorSource::IccLut);
    assert!(!lut.info.is_bounded_srgb());
    // P3 red stays outside sRGB, like the matrix/TRC profile.
    assert!(lut.image.data[0] > 1.15, "{:?}", &lut.image.data[0..3]);
    for (i, (a, b)) in lut.image.data.iter().zip(&matrix.image.data).enumerate() {
        assert!((a - b).abs() < 0.01, "sample {i}: LUT {a} vs matrix {b}");
    }
    // Core Image reads the perceptual table (A2B0) also when a colorimetric
    // one (A2B1) is present; with A2B1 alone, that one.
    let both = decode(lut_profile(Some(P3_TO_XYZ_D50), Some(REC2020_TO_XYZ_D50))).unwrap();
    assert_eq!(both.image.data, lut.image.data);
    let colorimetric = decode(lut_profile(None, Some(P3_TO_XYZ_D50))).unwrap();
    assert_eq!(colorimetric.image.data, lut.image.data);
    // An RGB profile with neither matrix/TRC nor A2B tables.
    let err = decode(lut_profile(None, None)).unwrap_err();
    assert!(
        matches!(err, decode::DecodeError::UnsupportedProfile(_)),
        "{err:?}"
    );
}

fn oversized_png_header(width: u32, height: u32) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn append_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        let mut crc_input = kind.to_vec();
        crc_input.extend_from_slice(data);
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        png.extend_from_slice(&crc_input);
        png.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    }

    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit RGB, standard compression/filter, no interlace.
    append_chunk(&mut png, b"IHDR", &ihdr);
    // Valid empty zlib stream: decoder construction reads the header, while pixel decode fails.
    append_chunk(
        &mut png,
        b"IDAT",
        &[0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01],
    );
    append_chunk(&mut png, b"IEND", &[]);
    png
}

fn jpeg_with_dimensions(mut jpeg: Vec<u8>, width: u16, height: u16) -> Vec<u8> {
    let mut offset = 2; // Skip SOI.
    while offset + 4 < jpeg.len() {
        while offset < jpeg.len() && jpeg[offset] == 0xff {
            offset += 1;
        }
        if offset >= jpeg.len() {
            break;
        }
        let marker = jpeg[offset];
        offset += 1;
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        let segment_len = u16::from_be_bytes([jpeg[offset], jpeg[offset + 1]]) as usize;
        let is_start_of_frame = matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        );
        if is_start_of_frame {
            jpeg[offset + 3..offset + 5].copy_from_slice(&height.to_be_bytes());
            jpeg[offset + 5..offset + 7].copy_from_slice(&width.to_be_bytes());
            return jpeg;
        }
        offset += segment_len;
    }
    panic!("fixture JPEG has no start-of-frame marker");
}

#[test]
fn raster_decoders_reject_oversized_jpeg_and_png_from_headers() {
    let jpeg = jpeg_with_dimensions(fixture("golden/input/dsc02078.jpg"), 8_000, 5_001);
    let error = decode::decode_raster(&jpeg, 2_048, Filter::Lanczos3).unwrap_err();
    assert!(error.to_string().contains("40000000 pixels"), "{error}");

    let png = oversized_png_header(8_000, 5_001);
    let error = decode::decode_raster(&png, 2_048, Filter::Lanczos3).unwrap_err();
    assert!(error.to_string().contains("40000000 pixels"), "{error}");
}

/// The native full-size export opens sources up to 100 MP (niho-photo#132);
/// every caller that does not choose (the browser's wasm) stays at 40 MP. A
/// 61 MP header passes the native check (its decode then fails only because
/// the pixels are not there); 100 MP + 1 does not.
#[test]
fn native_decode_limits_open_sources_above_the_browser_bound() {
    use niho_develop::decode::DecodeLimits;
    let png = oversized_png_header(9_504, 6_336);
    let browser = decode::decode_raster(&png, 0, Filter::Lanczos3).unwrap_err();
    assert!(browser.to_string().contains("40000000 pixels"), "{browser}");
    let native = decode::decode_raster_with_limits(&png, 0, Filter::Lanczos3, DecodeLimits::NATIVE)
        .unwrap_err();
    assert!(!native.to_string().contains("decode limit"), "{native}");
    let native =
        decode::decode_working_copy_with_limits(&png, 0, Filter::Lanczos3, DecodeLimits::NATIVE)
            .unwrap_err();
    assert!(!native.to_string().contains("decode limit"), "{native}");
    let browser = decode::decode_working_copy(&png, 0, Filter::Lanczos3).unwrap_err();
    assert!(browser.to_string().contains("40000000 pixels"), "{browser}");

    let too_large = oversized_png_header(10_000, 10_001);
    let error =
        decode::decode_raster_with_limits(&too_large, 0, Filter::Lanczos3, DecodeLimits::NATIVE)
            .unwrap_err();
    assert!(error.to_string().contains("100000000 pixels"), "{error}");
    let error = decode::decode_working_copy_with_limits(
        &too_large,
        0,
        Filter::Lanczos3,
        DecodeLimits::NATIVE,
    )
    .unwrap_err();
    assert!(error.to_string().contains("100000000 pixels"), "{error}");
    assert_eq!(
        DecodeLimits::BROWSER.max_pixels,
        decode::MAX_DECODE_IMAGE_PIXELS
    );
    assert_eq!(
        DecodeLimits::NATIVE.max_pixels,
        decode::MAX_NATIVE_DECODE_IMAGE_PIXELS
    );
}

#[test]
fn working_copy_decoder_rejects_oversized_png_from_header() {
    let png = oversized_png_header(8_000, 5_001);
    let error = decode::decode_working_copy(&png, 2_048, Filter::Lanczos3).unwrap_err();
    assert!(error.to_string().contains("40000000 pixels"), "{error}");
}

/// A JPEG at least 4x the render is decoded with the IDCT scaled by 1/2
/// (or more), then reduced in linear light: same size and source size as
/// the full decode, and close to it (README "性能": 6000px to 1280, mean
/// ΔE00 0.18-0.22).
#[test]
fn large_jpeg_is_decoded_at_a_reduced_scale() {
    let (w, h) = (2600u32, 1800u32);
    let pixels: Vec<u8> = (0..h)
        .flat_map(|y| {
            (0..w).flat_map(move |x| {
                let r = (x * 255 / w) as u8;
                let g = (y * 255 / h) as u8;
                // Fine detail too: a checker in blue.
                let b = if (x / 3 + y / 3) % 2 == 0 { 200 } else { 60 };
                [r, g, b]
            })
        })
        .collect();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
        .encode(&pixels, w, h, image::ExtendedColorType::Rgb8)
        .unwrap();
    let scaled = decode::decode_raster(&jpeg, 600, Filter::Lanczos3).unwrap();
    let full = decode::decode_raster(&jpeg, 0, Filter::Lanczos3).unwrap();
    assert_eq!((scaled.image.width, scaled.image.height), (600, 415));
    assert_eq!(
        (scaled.info.source_width, scaled.info.source_height),
        (2600, 1800)
    );
    let reduced = niho_develop::resize::resample(
        &full.image.data,
        full.image.width,
        full.image.height,
        600,
        415,
        Filter::Lanczos3,
    );
    assert_ne!(scaled.image.data, reduced, "the scaled path was not taken");
    let mean = scaled
        .image
        .data
        .iter()
        .zip(&reduced)
        .map(|(a, b)| (a - b).abs() as f64)
        .sum::<f64>()
        / reduced.len() as f64;
    assert!(mean < 0.01, "mean linear difference {mean}");
    // Smaller than 4x the render: the full decode, as before.
    let near = decode::decode_raster(&jpeg, 700, Filter::Lanczos3).unwrap();
    let near_full = niho_develop::resize::resample(
        &full.image.data,
        full.image.width,
        full.image.height,
        near.image.width,
        near.image.height,
        Filter::Lanczos3,
    );
    assert_eq!(near.image.data, near_full);

    // With EXIF orientation 6 (the APP1 segment of the orientation
    // fixture): turned like the full decode.
    let fixture_jpeg = fixture("golden/orientation-6.jpg");
    // The sanitized fixture has its minimal orientation APP1 immediately after SOI.
    let app1_at = 2;
    let app1_len =
        2 + u16::from_be_bytes([fixture_jpeg[app1_at + 2], fixture_jpeg[app1_at + 3]]) as usize;
    assert_eq!(fixture_jpeg[app1_at + 1], 0xE1);
    let mut oriented = jpeg[..2].to_vec();
    oriented.extend_from_slice(&fixture_jpeg[app1_at..app1_at + app1_len]);
    oriented.extend_from_slice(&jpeg[2..]);
    let turned = decode::decode_raster(&oriented, 600, Filter::Lanczos3).unwrap();
    assert!(turned.info.orientation_applied);
    assert_eq!((turned.image.width, turned.image.height), (415, 600));
    assert_eq!(
        (turned.info.source_width, turned.info.source_height),
        (1800, 2600)
    );
    // Rotated 90° CW: the new top-left is the original bottom-left (no red,
    // the most green).
    let px = &turned.image.data[0..3];
    assert!(px[0] < 0.05 && px[1] > 0.8, "{px:?}");
}
