//! A Session kept while its photo is closed and opened again (#129: the
//! editor's worker keeps the last photos' Developers) renders the same Final
//! bytes as a freshly opened Session, whatever it drew before: other
//! exposures and presets (masters, cubes, local passes), other color noise
//! reduction amounts (analyses), preset previews and drags. Making the
//! response analysis ahead (`Session::prepare_analysis`, the editor's idle
//! time) leaves the frames as they are too. Native and wasm.
use niho_develop::decode::encode_signed_working_copy;
use niho_develop::settings::{
    ENGINE_NIHO_11, ENGINE_NIHO_14, LOOK_NIHO_STANDARD_1, LOOK_NIHO_STANDARD_5,
};
use niho_develop::{encode, xmp, DevelopSettings, Filter, LinearImage, Quality, Session};

const PANASONIC: &str = "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4";
const SIZE: usize = 64;

/// A room with a clipped window, a saturated object and noise (enough for
/// the response analysis, the highlight maps and the local levels).
fn linear() -> LinearImage {
    let (width, height) = (96usize, 72usize);
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

fn signed() -> (Vec<u8>, String) {
    let (png, encoding) = encode_signed_working_copy(&linear()).unwrap();
    let meta = format!(
        r#"{{"kind":"raw","baselineEV":-0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":4}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"{PANASONIC}","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    (png, meta)
}

fn raster() -> Vec<u8> {
    let (width, height) = (120usize, 90usize);
    let mut rgba = Vec::with_capacity(width * height * 4);
    let mut state = 0x2f6b_4e1du32;
    for y in 0..height {
        for x in 0..width {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 7) as i32 - 3;
            let (r, g, b) = if x > 80 && y < 40 {
                (235, 240, 250)
            } else if (x as i32 - 34).pow(2) + (y as i32 - 60).pow(2) < 300 {
                (170, 40, 30)
            } else {
                (20 + x as i32 / 2, 18 + y as i32 / 2, 16 + x as i32 / 3)
            };
            let c = |v: i32| (v + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
        }
    }
    encode::encode_png(&rgba, width, height).unwrap()
}

/// The settings an editor goes through: as opened, an exposure step, each
/// bundled preset on it (colorful changes the color noise reduction), and
/// Highlights / Shadows / Texture by hand.
fn steps(
    base: DevelopSettings,
    as_shot: Option<niho_develop::LightroomWhite>,
) -> Vec<DevelopSettings> {
    let mut exposed = base.clone();
    exposed.exposure = 0.3;
    let mut steps = vec![base.clone(), exposed.clone()];
    for preset in xmp::BUILTIN_PRESETS.iter() {
        steps.push(
            xmp::apply_preset(preset.xmp, &exposed, 1.0, as_shot)
                .unwrap()
                .settings,
        );
    }
    let mut manual = exposed;
    manual.highlights = -60.0;
    manual.shadows = 40.0;
    manual.texture = 15.0;
    steps.push(manual.clone());
    manual.color_noise_reduction = 25.0;
    steps.push(manual);
    steps
}

/// What a kept Session went through before the photo was opened again:
/// every step released (Final), dragged (Interactive), drawn as a preset
/// preview, in an order unlike the one the check renders in.
fn history(session: &mut Session, steps: &[DevelopSettings]) {
    for settings in steps {
        session.prepare_analysis(settings).unwrap();
    }
    for settings in steps.iter().rev() {
        session.render(settings, SIZE, Quality::Final).unwrap();
        let mut dragged = settings.clone();
        for tick in 1..=3 {
            dragged.exposure = settings.exposure + 0.1 * f64::from(tick);
            session
                .render(&dragged, SIZE, Quality::Interactive)
                .unwrap();
        }
    }
    let mut previews = session.thumbnail(32);
    for settings in steps {
        previews.render(settings, 0, Quality::Final).unwrap();
    }
}

fn assert_kept_matches_fresh(open: impl Fn() -> Session, base: DevelopSettings, label: &str) {
    let mut kept = open();
    let as_shot = kept.as_shot_white();
    let steps = steps(base, as_shot);
    history(&mut kept, &steps);
    for (index, settings) in steps.iter().enumerate() {
        let fresh = open().render(settings, SIZE, Quality::Final).unwrap();
        let again = kept.render(settings, SIZE, Quality::Final).unwrap();
        assert_eq!(
            (again.width, again.height),
            (fresh.width, fresh.height),
            "{label} step {index}"
        );
        assert!(again.rgba == fresh.rgba, "{label} step {index}");
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_kept_signed_raw_session_renders_what_a_fresh_one_does() {
    let (png, meta) = signed();
    let mut base = DevelopSettings::neutral();
    base.engine = ENGINE_NIHO_11.into();
    base.look = LOOK_NIHO_STANDARD_5.into();
    assert_kept_matches_fresh(
        || Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap(),
        base,
        "niho-11",
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_kept_raster_session_renders_what_a_fresh_one_does() {
    let png = raster();
    let mut base = DevelopSettings::neutral();
    base.engine = ENGINE_NIHO_14.into();
    base.look = LOOK_NIHO_STANDARD_1.into();
    assert_kept_matches_fresh(
        || Session::open_raster(&png, 0, Filter::Lanczos3).unwrap(),
        base,
        "niho-14",
    );
}

/// The analysis made ahead is the one the frames would make: a Session that
/// makes it first (for the photo's settings and for each preset's noise
/// reduction, as the editor does once the photo is open) draws every step
/// as a fresh Session does, in the order an editor goes through them.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn an_analysis_made_ahead_leaves_the_frames_as_they_are() {
    let (png, meta) = signed();
    let open = || Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    let mut base = DevelopSettings::neutral();
    base.engine = ENGINE_NIHO_11.into();
    base.look = LOOK_NIHO_STANDARD_5.into();
    let mut session = open();
    let steps = steps(base.clone(), session.as_shot_white());
    session.render(&base, SIZE, Quality::Final).unwrap();
    for settings in &steps {
        assert!(session.prepare_analysis(settings).unwrap());
    }
    // Back and forth between the noise reductions (colorful is step 4).
    for index in [2, 4, 3, 4, 5, 6, 2] {
        let fresh = open().render(&steps[index], SIZE, Quality::Final).unwrap();
        let ahead = session.render(&steps[index], SIZE, Quality::Final).unwrap();
        assert!(ahead.rgba == fresh.rgba, "step {index}");
    }

    let mut raster_base = DevelopSettings::neutral();
    raster_base.engine = ENGINE_NIHO_14.into();
    raster_base.look = LOOK_NIHO_STANDARD_1.into();
    let png = raster();
    let mut raster = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    assert!(!raster.prepare_analysis(&raster_base).unwrap());
}
