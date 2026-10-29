//! The response analysis as bytes (#155): what one Session of a photo made
//! (`Session::export_analysis`, the editor's helper worker) and another
//! Session of the same photo took in (`Session::import_analysis`, the
//! editor's own) draws the Final and Interactive frames a fresh Session
//! draws. The frames read the analysis taken in (it is not made again), and
//! bytes of another photo, broken or of another version change nothing.
//! Native and wasm.
use niho_develop::decode::encode_signed_working_copy;
use niho_develop::settings::{
    DetailSettings, ENGINE_NIHO_11, ENGINE_NIHO_14, LOOK_NIHO_STANDARD_1, LOOK_NIHO_STANDARD_5,
};
use niho_develop::{encode, xmp, DevelopSettings, Filter, LinearImage, Quality, Session};

const PANASONIC: &str = "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4";
const SONY_ZV: &str = "apple-ciraw8/linear-prophoto-d50/cal-sony-zv-e10m2-apple-v3";
const SONY_FX30: &str = "apple-ciraw8/linear-prophoto-d50/cal-sony-ilme-fx30-apple-v2";
const SIZE: usize = 64;
const BASELINE: f64 = -0.25;

/// A room with a clipped window, a saturated object and noise (enough for
/// the response analysis, the highlight maps and the local levels).
fn linear(width: usize, height: usize) -> LinearImage {
    let mut state = 0x6d2b_79f5u32;
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = ((state % 17) as f32 - 8.0) / 400.0;
            let pixel = if x > 60 && y < 30 {
                [2.4, 2.3, 2.1]
            } else if (x as i32 - 28).pow(2) + (y as i32 - 48).pow(2) < 180 {
                [0.62, 0.08, 0.05]
            } else {
                [
                    0.02 + x as f32 / 300.0,
                    0.03 + y as f32 / 260.0,
                    0.04 + (x + y) as f32 / 700.0,
                ]
            };
            data.extend(pixel.map(|value| value + noise));
        }
    }
    LinearImage {
        width,
        height,
        data,
    }
}

/// A signed working copy of `linear(width, height)` and its metadata.
struct Photo {
    png: Vec<u8>,
    meta: String,
}

impl Photo {
    fn new(camera: &str, baseline: f64, width: usize, height: usize) -> Self {
        let (png, encoding) = encode_signed_working_copy(&linear(width, height)).unwrap();
        let meta = format!(
            r#"{{"kind":"raw","baselineEV":{baseline},"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":4}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"{camera}","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
            encoding.ceiling()
        );
        Self { png, meta }
    }

    fn of(camera: &str) -> Self {
        Self::new(camera, BASELINE, 96, 72)
    }

    fn open(&self) -> Session {
        Session::open_working_copy(&self.png, &self.meta, Filter::Lanczos3).unwrap()
    }
}

fn base() -> DevelopSettings {
    let mut base = DevelopSettings::neutral();
    base.engine = ENGINE_NIHO_11.into();
    base.look = LOOK_NIHO_STANDARD_5.into();
    base
}

/// The settings whose frames read the analysis: each bundled preset on the
/// photo as opened (colorful at its color noise reduction), and Highlights /
/// Shadows by hand at CNR 0, at CNR 25 and with luminance noise reduction.
fn steps(session: &Session) -> Vec<DevelopSettings> {
    let as_shot = session.as_shot_white();
    let mut steps: Vec<DevelopSettings> = xmp::BUILTIN_PRESETS
        .iter()
        .map(|preset| {
            xmp::apply_preset(preset.xmp, &base(), 1.0, as_shot)
                .unwrap()
                .settings
        })
        .collect();
    let mut manual = base();
    manual.highlights = -60.0;
    manual.shadows = 40.0;
    steps.push(manual.clone());
    let mut cnr = manual.clone();
    cnr.color_noise_reduction = 25.0;
    steps.push(cnr);
    manual.detail = Some(DetailSettings {
        luminance_noise_reduction: 30.0,
        ..DetailSettings::default()
    });
    steps.push(manual);
    steps
}

/// Highlights / Shadows by hand at `cnr`.
fn manual(cnr: f64) -> DevelopSettings {
    let mut manual = base();
    manual.highlights = -60.0;
    manual.shadows = 40.0;
    manual.color_noise_reduction = cnr;
    manual
}

fn dragged(settings: &DevelopSettings) -> DevelopSettings {
    let mut dragged = settings.clone();
    dragged.exposure += 0.2;
    dragged
}

fn export(photo: &Photo, settings: &DevelopSettings) -> Vec<u8> {
    photo
        .open()
        .export_analysis(settings)
        .unwrap()
        .expect("a signed RAW analysis")
}

fn rgba(session: &mut Session, settings: &DevelopSettings, quality: Quality) -> Vec<u8> {
    session.render(settings, SIZE, quality).unwrap().rgba
}

/// The analysis another Session made and gave as bytes draws every step as
/// a fresh Session does (Final, and Interactive from a reduced master), on
/// the residual (DC-S5) and shoulder (FX30) highlight maps.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn an_analysis_taken_in_draws_what_a_fresh_session_does() {
    for camera in [PANASONIC, SONY_FX30] {
        let photo = Photo::of(camera);
        for (index, settings) in steps(&photo.open()).iter().enumerate() {
            let bytes = export(&photo, settings);

            let mut taker = photo.open();
            assert!(taker.import_analysis(&bytes).unwrap(), "{camera} {index}");
            let fresh = rgba(&mut photo.open(), settings, Quality::Final);
            assert!(
                rgba(&mut taker, settings, Quality::Final) == fresh,
                "{camera} step {index} Final"
            );
            let fresh = rgba(&mut photo.open(), &dragged(settings), Quality::Interactive);
            let mut dragging = photo.open();
            assert!(dragging.import_analysis(&bytes).unwrap());
            assert!(
                rgba(&mut dragging, &dragged(settings), Quality::Interactive) == fresh,
                "{camera} step {index} Interactive"
            );
            // Taking in what it holds changes nothing.
            assert!(!taker.import_analysis(&bytes).unwrap(), "{camera} {index}");
        }
    }
}

/// Where the coefficients' maps start in `bytes` and how many values each
/// has (format version 1, `src/niho4/transfer.rs`).
fn coefficient_maps(bytes: &[u8]) -> (usize, usize) {
    let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    let (width, height) = (u32_at(33), u32_at(37));
    let mut at = 41;
    at += match bytes[at] {
        0 => 1,
        _ => 1 + width * height * 3 * 4,
    };
    assert_eq!(bytes[at], 1, "coefficients");
    (at + 9, u32_at(at + 1) * u32_at(at + 5))
}

/// Scales `count` f32 values from `at`.
fn scale(bytes: &mut [u8], at: usize, count: usize, factor: f32) {
    for value in bytes[at..at + count * 4].chunks_exact_mut(4) {
        let scaled = f32::from_le_bytes(value.try_into().unwrap()) * factor;
        value.copy_from_slice(&scaled.to_le_bytes());
    }
}

/// The frames read the analysis taken in as it is (it is not made again):
/// bytes whose coefficients (or CNR source) were changed draw another
/// frame. Into a master of the same noise reduction without coefficients
/// (a frame without Highlights / Shadows), they set only the coefficients.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_frames_read_the_analysis_taken_in() {
    let photo = Photo::of(PANASONIC);
    for cnr in [0.0, 25.0] {
        let settings = manual(cnr);
        let fresh = rgba(&mut photo.open(), &settings, Quality::Final);
        let bytes = export(&photo, &settings);

        // Doubled response coefficients (still valid): another frame.
        let mut changed = bytes.clone();
        let (at, count) = coefficient_maps(&changed);
        for map in [0, 1, 3, 4] {
            scale(&mut changed, at + map * count * 4, count, 2.0);
        }
        let mut taker = photo.open();
        assert!(taker.import_analysis(&changed).unwrap());
        assert!(
            rgba(&mut taker, &settings, Quality::Final) != fresh,
            "CNR {cnr}"
        );

        // The master of a frame without Highlights / Shadows has the CNR
        // source only: the bytes add the coefficients to it.
        let mut held = photo.open();
        let mut plain = settings.clone();
        plain.highlights = 0.0;
        plain.shadows = 0.0;
        held.render(&plain, SIZE, Quality::Final).unwrap();
        assert!(held.import_analysis(&changed).unwrap());
        assert!(!held.import_analysis(&bytes).unwrap());
        assert!(
            rgba(&mut held, &settings, Quality::Final) != fresh,
            "CNR {cnr}"
        );
    }

    // A darker CNR source: another frame.
    let settings = manual(25.0);
    let fresh = rgba(&mut photo.open(), &settings, Quality::Final);
    let mut changed = export(&photo, &settings);
    assert_eq!(changed[41], 1, "filtered CNR source");
    scale(&mut changed, 42, 96 * 72 * 3, 0.5);
    let mut taker = photo.open();
    assert!(taker.import_analysis(&changed).unwrap());
    assert!(rgba(&mut taker, &settings, Quality::Final) != fresh);
}

/// Bytes of another photo (camera, baseline exposure, size, a JPEG / PNG),
/// broken or of another version are an error that changes nothing: the
/// Session draws as a fresh one and still takes in its own bytes.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn bytes_of_another_photo_or_broken_bytes_change_nothing() {
    let photo = Photo::of(PANASONIC);
    let settings = manual(25.0);
    let bytes = export(&photo, &settings);
    let fresh = rgba(&mut photo.open(), &settings, Quality::Final);

    let edited = |edit: &dyn Fn(&mut Vec<u8>)| {
        let mut edited = bytes.clone();
        edit(&mut edited);
        edited
    };
    let refused = [
        ("empty", Vec::new()),
        ("header only", bytes[..10].to_vec()),
        ("one byte short", bytes[..bytes.len() - 1].to_vec()),
        ("one byte more", edited(&|copy| copy.push(0))),
        ("magic", edited(&|copy| copy[0] = b'X')),
        (
            "version 2",
            edited(&|copy| copy[6..8].copy_from_slice(&2u16.to_le_bytes())),
        ),
        ("unknown camera", edited(&|copy| copy[8] = 9)),
        (
            "CNR source of no noise reduction",
            edited(&|copy| copy[41] = 0),
        ),
        ("another camera", export(&Photo::of(SONY_ZV), &settings)),
        (
            "another baseline",
            export(&Photo::new(PANASONIC, -0.5, 96, 72), &settings),
        ),
        (
            "another size",
            export(&Photo::new(PANASONIC, BASELINE, 100, 72), &settings),
        ),
    ];

    let mut session = photo.open();
    for (label, refused) in &refused {
        let error = session.import_analysis(refused).unwrap_err();
        assert!(
            error.to_string().starts_with("analysis_transfer_failed"),
            "{label}: {error}"
        );
    }
    assert!(rgba(&mut session, &settings, Quality::Final) == fresh);
    let mut session = photo.open();
    for (_, refused) in &refused {
        assert!(session.import_analysis(refused).is_err());
    }
    assert!(session.import_analysis(&bytes).unwrap());
    assert!(rgba(&mut session, &settings, Quality::Final) == fresh);

    let mut raster = Session::open_raster(&raster_png(), 0, Filter::Lanczos3).unwrap();
    assert!(raster.import_analysis(&bytes).is_err());
}

fn raster_png() -> Vec<u8> {
    let (width, height) = (40usize, 30usize);
    let rgba: Vec<u8> = (0..width * height)
        .flat_map(|index| [(index % 251) as u8, (index % 113) as u8, 90, 255])
        .collect();
    encode::encode_png(&rgba, width, height).unwrap()
}

/// Nothing to make for a JPEG / PNG (no signed RAW analysis).
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_raster_photo_has_no_analysis_to_give() {
    let mut settings = DevelopSettings::neutral();
    settings.engine = ENGINE_NIHO_14.into();
    settings.look = LOOK_NIHO_STANDARD_1.into();
    settings.highlights = -60.0;
    let mut raster = Session::open_raster(&raster_png(), 0, Filter::Lanczos3).unwrap();
    assert_eq!(raster.export_analysis(&settings).unwrap(), None);
}
