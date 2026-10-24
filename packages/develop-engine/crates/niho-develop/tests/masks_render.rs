//! The layered render of local masks (`docs/local-adjustments.md` "描画と混ぜ方",
//! Epic #31 M2 = #66) through `Session::render` and the one-shot render: a
//! mask whose plane is 1 everywhere draws its local settings' frame exactly
//! (as a Session that renders those settings alone), 0 everywhere the
//! global frame; the masked region follows the content through the
//! geometry; the masks' order does not matter; inert masks leave every byte
//! as without them. On a JPEG / PNG (`niho-10`, with and without its
//! response master), a legacy RAW working copy and a signed RAW working copy
//! (`niho-11`, whose master a local exposure changes).

use niho_develop::decode::{encode_signed_working_copy, encode_working_copy};
use niho_develop::{
    encode, render, DevelopSettings, Filter, LinearImage, Quality, RenderOptions, Session,
};
use serde_json::{json, Value};

fn photo_png(w: usize, h: usize) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let window = x > w * 2 / 3 && y < h / 3;
            let (r, g, b) = if window {
                (235, 240, 250)
            } else {
                (
                    (20 + x * 180 / w) as u8,
                    (30 + y * 150 / h) as u8,
                    ((x + y) * 90 / (w + h) + 40) as u8,
                )
            };
            rgba.extend_from_slice(&[r, g, b, 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

fn linear_image(w: usize, h: usize, bright: f32) -> LinearImage {
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let t = x as f32 / (w - 1) as f32;
            let u = y as f32 / (h - 1) as f32;
            let highlight = (w / 3..w / 2).contains(&x) && (h / 6..h / 2).contains(&y);
            data.extend_from_slice(&if highlight {
                [bright, bright, bright]
            } else {
                [
                    0.02 + 0.9 * t * t,
                    0.04 + 0.5 * u,
                    0.1 + 0.4 * (1.0 - t) * u,
                ]
            });
        }
    }
    LinearImage {
        width: w,
        height: h,
        data,
    }
}

const LEGACY_META: &str = r#"{"kind":"raw","baselineEV":0.1,"asShotWhite":{"x":0.3324,"y":0.3474,"temperature":5400,"tint":4},"asShotWhiteAdobe":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v2","lookTableIncluded":false}"#;

fn signed_meta(ceiling: f64) -> String {
    format!(
        r#"{{"kind":"raw","baselineEV":-0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":0}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{ceiling}}}}}"#
    )
}

/// The kinds of source a Session opens, each with the settings it renders.
enum Photo {
    Raster(Vec<u8>),
    Legacy(Vec<u8>),
    Signed(Vec<u8>, String),
}

impl Photo {
    fn open(&self) -> Session {
        match self {
            Photo::Raster(png) => Session::open_raster(png, 0, Filter::Lanczos3).unwrap(),
            Photo::Legacy(png) => {
                Session::open_working_copy(png, LEGACY_META, Filter::Lanczos3).unwrap()
            }
            Photo::Signed(png, meta) => {
                Session::open_working_copy(png, meta, Filter::Lanczos3).unwrap()
            }
        }
    }

    fn base(&self) -> Value {
        match self {
            Photo::Raster(_) => json!({
                "v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null,
                "shadows": 30, "contrast": 10
            }),
            Photo::Legacy(_) => json!({
                "v": 5, "engine": "niho-2", "look": "niho-standard-1", "base": null,
                "shadows": 20, "vibrance": 10
            }),
            Photo::Signed(..) => json!({
                "v": 5, "engine": "niho-11", "look": "niho-standard-5", "base": null,
                "exposure": -0.2, "highlights": -40
            }),
        }
    }

    fn all() -> Vec<(&'static str, Photo)> {
        let (signed, encoding) = encode_signed_working_copy(&linear_image(96, 64, 2.5)).unwrap();
        vec![
            ("raster", Photo::Raster(photo_png(120, 80))),
            (
                "legacy RAW",
                Photo::Legacy(encode_working_copy(&linear_image(96, 64, 0.9))),
            ),
            (
                "signed RAW",
                Photo::Signed(signed, signed_meta(encoding.ceiling())),
            ),
        ]
    }
}

fn settings(base: &Value, extra: Value) -> DevelopSettings {
    let mut v = base.clone();
    for (k, value) in extra.as_object().unwrap() {
        v[k] = value.clone();
    }
    DevelopSettings::from_value(&v).unwrap()
}

/// A linear mask that is 1 over the whole photo (its ramp ends above it).
fn everywhere(id: &str, adjust: Value) -> Value {
    json!({
        "id": id, "kind": "linear",
        "zero": {"x": 0.5, "y": -1}, "full": {"x": 0.5, "y": -0.001},
        "adjust": adjust
    })
}

fn local(base: &Value, extra: Value, adjust: &Value) -> DevelopSettings {
    let mut s = settings(base, extra);
    let a = adjust.as_object().unwrap();
    let add = |v: f64, key: &str, lo: f64, hi: f64| {
        (v + a.get(key).and_then(Value::as_f64).unwrap_or(0.0)).clamp(lo, hi)
    };
    s.exposure = add(s.exposure, "exposure", -5.0, 5.0);
    s.highlights = add(s.highlights, "highlights", -100.0, 100.0);
    s.shadows = add(s.shadows, "shadows", -100.0, 100.0);
    s.saturation = add(s.saturation, "saturation", -100.0, 100.0);
    s.clarity = add(s.clarity, "clarity", -100.0, 100.0);
    s.texture = add(s.texture, "texture", -100.0, 100.0);
    s
}

#[test]
fn a_full_plane_draws_the_local_frame_and_an_empty_one_the_global() {
    // Cube-only deltas, deltas of the master's inputs and of the local pass.
    let adjusts = [
        json!({"saturation": -30}),
        json!({"exposure": -0.8}),
        json!({"shadows": 25, "clarity": 20}),
    ];
    for (name, photo) in Photo::all() {
        let base = photo.base();
        for geometry in [
            Value::Null,
            json!({"rotate": 90, "crop": {"left": 0.1, "top": 0.05, "right": 0.9, "bottom": 0.8}}),
        ] {
            let extra = if geometry.is_null() {
                json!({})
            } else {
                json!({ "geometry": geometry })
            };
            for adjust in &adjusts {
                let masked = settings(
                    &base,
                    json!({ "masks": [everywhere("all", adjust.clone())], "geometry": geometry }),
                );
                let mut inverted = masked.clone();
                inverted.masks[0].invert = true;
                let global = settings(&base, extra.clone());
                let l = local(&base, extra.clone(), adjust);
                for (quality, size) in [(Quality::Final, 0usize), (Quality::Interactive, 48)] {
                    let mut session = photo.open();
                    let frame = session.render(&masked, size, quality).unwrap();
                    let expected = photo.open().render(&l, size, quality).unwrap();
                    assert_eq!(
                        frame.rgba, expected.rgba,
                        "{name} {geometry} {adjust} {quality:?}: m = 1 is R_k"
                    );
                    let frame = session.render(&inverted, size, quality).unwrap();
                    let expected = photo.open().render(&global, size, quality).unwrap();
                    assert_eq!(
                        frame.rgba, expected.rgba,
                        "{name} {geometry} {adjust} {quality:?}: m = 0 is R0"
                    );
                    assert_eq!(
                        frame.approximations, expected.approximations,
                        "{name} {adjust}"
                    );
                }
            }
        }
    }
}

#[test]
fn a_final_render_invalidates_interactive_frames_from_frozen_niho6_analysis() {
    let photo = Photo::all()
        .into_iter()
        .find_map(|(name, photo)| (name == "legacy RAW").then_some(photo))
        .unwrap();
    let base = photo.base();
    let masked = |exposure: f64, saturation: f64| {
        settings(
            &base,
            json!({
                "exposure": exposure,
                "masks": [{
                    "id": "color", "kind": "radial",
                    "center": {"x": 0.4, "y": 0.5}, "radius": {"x": 0.3, "y": 0.4},
                    "angle": 15, "feather": 60, "adjust": {"saturation": saturation}
                }]
            }),
        )
    };
    let mut session = photo.open();
    session
        .render(&masked(0.4, 25.0), 64, Quality::Interactive)
        .unwrap();
    session
        .render(&masked(-0.8, 25.0), 64, Quality::Interactive)
        .unwrap();
    session
        .render(&masked(-0.8, 25.0), 64, Quality::Final)
        .unwrap();
    let actual = session
        .render(&masked(-0.8, 40.0), 64, Quality::Interactive)
        .unwrap();

    let mut fresh = photo.open();
    fresh
        .render(&masked(-0.8, 25.0), 64, Quality::Final)
        .unwrap();
    let expected = fresh
        .render(&masked(-0.8, 40.0), 64, Quality::Interactive)
        .unwrap();
    assert!(
        actual.rgba == expected.rgba,
        "interactive masked output must use the analysis refreshed by the Final render"
    );
}

/// `clamp(R0 + sum_k ((R_k^a - R0^a) * w_k + 32768) >> 16)` per channel:
/// the layers' differences of the anchor frame on another `R0`.
fn on_r0(r0: &[u8], anchor: &[u8], layers: &[(Vec<u8>, Vec<u32>)]) -> Vec<u8> {
    let mut out = r0.to_vec();
    for p in 0..r0.len() / 4 {
        for c in 0..3 {
            let mut acc = i32::from(r0[p * 4 + c]);
            for (rgba, weights) in layers {
                let diff = i32::from(rgba[p * 4 + c]) - i32::from(anchor[p * 4 + c]);
                acc += (diff * weights[p] as i32 + 32768) >> 16;
            }
            out[p * 4 + c] = acc.clamp(0, 255) as u8;
        }
    }
    out
}

#[test]
fn a_global_drag_reuses_the_layers_differences_and_anything_else_is_exact() {
    use niho_develop::local_render::{self, SourceMap};
    let q = Quality::Interactive;
    let masks = json!([
        {"id": "sky", "kind": "linear", "zero": {"x": 0.5, "y": 0.6}, "full": {"x": 0.5, "y": 0.15},
         "adjust": {"exposure": -0.6, "saturation": 15}},
        {"id": "spot", "kind": "radial", "center": {"x": 0.6, "y": 0.6}, "radius": {"x": 0.25, "y": 0.3},
         "angle": 20, "feather": 60, "adjust": {"shadows": 25, "clarity": 20}}
    ]);
    for (name, photo) in Photo::all() {
        let base = photo.base();
        let at = |extra: Value| {
            let mut s = settings(&base, extra);
            s.masks = settings(&base, json!({ "masks": masks.clone() })).masks;
            s
        };
        let fresh = |s: &DevelopSettings, size: usize| photo.open().render(s, size, q).unwrap();
        let anchor = at(json!({"contrast": 10}));
        let dragged = at(json!({"contrast": 16}));
        let mut session = photo.open();
        // The anchor frame is the exact one.
        let first = session.render(&anchor, 48, q).unwrap();
        assert_eq!(first.rgba, fresh(&anchor, 48).rgba, "{name}: the anchor");
        // A drag frame: R0 as the global path draws it in the same drag, plus
        // the anchor's differences of the layers (each as a new Session
        // draws it, with its plane).
        let frame = session.render(&dragged, 48, q).unwrap();
        let mut global = photo.open();
        let r0_anchor = global
            .render(&local_render::without_masks(&anchor), 48, q)
            .unwrap();
        let r0 = global
            .render(&local_render::without_masks(&dragged), 48, q)
            .unwrap();
        let (ws, hs) = match &photo {
            Photo::Raster(_) => (120, 80),
            _ => (96, 64),
        };
        let map = SourceMap::new(None, ws, hs).unwrap();
        let layers: Vec<(Vec<u8>, Vec<u32>)> = anchor
            .masks
            .iter()
            .map(|mask| {
                let local = local_render::local_settings(
                    &local_render::without_masks(&anchor),
                    &mask.adjust,
                );
                let rk = fresh(&local, 48);
                let weights =
                    local_render::mask_weights(mask, &map, r0.width, r0.height, None).unwrap();
                (rk.rgba, weights)
            })
            .collect();
        assert_eq!(
            frame.rgba,
            on_r0(&r0.rgba, &r0_anchor.rgba, &layers),
            "{name}: R0 plus the anchor's differences"
        );
        assert_ne!(frame.rgba, fresh(&dragged, 48).rgba, "{name}: approximate");
        // Anything but one global slider within its bound draws the layers:
        // the exact frame after the same first frame (a drag's frames keep
        // the niho-6 analysis of its first one, so the legacy RAW's differ
        // from a new Session's whether or not the layers are reused).
        let mut edited = dragged.clone();
        edited.masks[0].invert = true;
        let mut preset =
            at(json!({"contrast": 30, "vibrance": 20, "hsl": ["blue", {"saturation": -20}]}));
        preset.masks = dragged.masks.clone();
        let turned = at(json!({"contrast": 16, "geometry": {"rotate": 90}}));
        let curve = at(
            json!({"contrast": 16, "toneCurves": [{"channel": "rgb", "points": [{"x": 0, "y": 0.05}, {"x": 1, "y": 1}]}]}),
        );
        let far = at(json!({"contrast": 36}));
        let mut white = at(json!({"contrast": 16, "relativeTemperature": 10}));
        white.white_balance.mode = niho_develop::settings::WhiteBalanceMode::Relative;
        for (change, s, size) in [
            ("a mask edited", &edited, 48),
            ("a preset", &preset, 48),
            ("another size", &dragged, 40),
            ("a turn", &turned, 48),
            ("a curve", &curve, 48),
            ("past the bound", &far, 48),
            ("the white balance's mode", &white, 48),
        ] {
            // From the drag frame (its anchor), as the editor goes on.
            let mut session = photo.open();
            session.render(&anchor, 48, q).unwrap();
            session.render(&dragged, 48, q).unwrap();
            let mut exact = photo.open();
            exact.render(&anchor, 48, q).unwrap();
            assert_eq!(
                session.render(s, size, q).unwrap().rgba,
                exact.render(s, size, q).unwrap().rgba,
                "{name}: {change}"
            );
        }
        // Released after the drag: the Final frame is a new Session's.
        let released = session.render(&dragged, 0, Quality::Final).unwrap();
        assert_eq!(
            released.rgba,
            photo
                .open()
                .render(&dragged, 0, Quality::Final)
                .unwrap()
                .rgba,
            "{name}: released"
        );
    }
}

#[test]
fn a_linear_exposure_mask_darkens_only_past_its_ramp() {
    let png = photo_png(120, 80);
    let base = json!({"v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null});
    // Exposure -1 from x = 0.25 (none) to x = 0.5 (all).
    let mask = json!({
        "id": "ramp", "kind": "linear",
        "zero": {"x": 0.25, "y": 0.5}, "full": {"x": 0.5, "y": 0.5},
        "adjust": {"exposure": -1}
    });
    let masked = settings(&base, json!({ "masks": [mask] }));
    let plain = settings(&base, json!({}));
    for quality in [Quality::Interactive, Quality::Final] {
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        let frame = session.render(&masked, 0, quality).unwrap();
        let before = session.render(&plain, 0, quality).unwrap();
        let luma = |rgba: &[u8], x: usize, y: usize| {
            let p = &rgba[(y * 120 + x) * 4..];
            u32::from(p[0]) + u32::from(p[1]) + u32::from(p[2])
        };
        for y in [5usize, 40, 75] {
            for x in 0..29 {
                assert_eq!(
                    luma(&frame.rgba, x, y),
                    luma(&before.rgba, x, y),
                    "{quality:?} ({x}, {y}) before the ramp"
                );
            }
            for x in [45usize, 60, 90, 119] {
                assert!(
                    luma(&frame.rgba, x, y) < luma(&before.rgba, x, y),
                    "{quality:?} ({x}, {y}) past it"
                );
            }
        }
        // Removing the mask gives back the frame of the plain settings.
        assert_eq!(
            session.render(&plain, 0, quality).unwrap().rgba,
            before.rgba
        );
    }
}

#[test]
fn the_masked_region_follows_the_content_through_a_quarter_turn() {
    // Per-pixel stages only (no spatial pass), so the turned frame is the
    // frame turned; the plane is evaluated on the turned output.
    let png = photo_png(120, 80);
    let base = json!({"v": 5, "engine": "niho-1", "look": "niho-standard-1", "base": null});
    let mask = json!({
        "id": "spot", "kind": "radial",
        "center": {"x": 0.3, "y": 0.4}, "radius": {"x": 0.15, "y": 0.2},
        "angle": 25, "feather": 40,
        "adjust": {"exposure": -1.2, "saturation": 30}
    });
    let upright = settings(&base, json!({ "masks": [mask.clone()] }));
    let turned = settings(
        &base,
        json!({ "masks": [mask], "geometry": {"rotate": 90} }),
    );
    let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let a = session.render(&upright, 0, Quality::Final).unwrap();
    let b = session.render(&turned, 0, Quality::Final).unwrap();
    assert_eq!((b.width, b.height), (80, 120));
    let mut darkened = 0;
    for j in 0..120 {
        for i in 0..80 {
            // Turned output (i, j) is source (j, 79 - i).
            let p = &b.rgba[(j * 80 + i) * 4..(j * 80 + i) * 4 + 3];
            let q = &a.rgba[((79 - i) * 120 + j) * 4..((79 - i) * 120 + j) * 4 + 3];
            for c in 0..3 {
                // The map's rounding can move a weight by one step: at most
                // one level of the blend.
                assert!(p[c].abs_diff(q[c]) <= 1, "({i}, {j}): {p:?} {q:?}");
            }
            darkened += usize::from(p != q);
        }
    }
    assert!(darkened < 40, "{darkened} pixels off by a level");
    let plain = settings(&base, json!({ "geometry": {"rotate": 90} }));
    let unmasked = session.render(&plain, 0, Quality::Final).unwrap();
    assert_ne!(unmasked.rgba, b.rgba, "the mask moved with the turn");
}

#[test]
fn the_masks_order_does_not_change_the_frame_and_every_mask_counts() {
    let png = photo_png(120, 80);
    let base = json!({"v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null, "shadows": 20});
    let a = json!({
        "id": "a", "kind": "linear",
        "zero": {"x": 0.1, "y": 0.1}, "full": {"x": 0.7, "y": 0.6},
        "adjust": {"exposure": -0.6, "texture": 30}
    });
    let b = json!({
        "id": "b", "kind": "radial", "invert": true,
        "center": {"x": 0.5, "y": 0.5}, "radius": {"x": 0.3, "y": 0.35},
        "angle": -30, "feather": 70,
        "adjust": {"saturation": 40, "highlights": -50}
    });
    let c = json!({
        "id": "c", "kind": "radial",
        "center": {"x": 0.7, "y": 0.3}, "radius": {"x": 0.2, "y": 0.2},
        "angle": 0, "feather": 20,
        "adjust": {"hsl": ["blue", {"saturation": -60}], "relativeTemperature": 25}
    });
    let abc = settings(&base, json!({ "masks": [a.clone(), b.clone(), c.clone()] }));
    let cab = settings(&base, json!({ "masks": [c.clone(), a.clone(), b.clone()] }));
    for quality in [Quality::Final, Quality::Interactive] {
        let x = Session::open_raster(&png, 0, Filter::Lanczos3)
            .unwrap()
            .render(&abc, 64, quality)
            .unwrap();
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        let y = session.render(&cab, 64, quality).unwrap();
        assert_eq!(x.rgba, y.rgba, "{quality:?}");
        // The same session after reordering: the kept layers serve.
        assert_eq!(session.render(&abc, 64, quality).unwrap().rgba, x.rgba);
        let only_a = session
            .render(
                &settings(&base, json!({ "masks": [a.clone()] })),
                64,
                quality,
            )
            .unwrap();
        assert_ne!(only_a.rgba, x.rgba);
    }
}

#[test]
fn inert_masks_leave_every_byte_as_without_them() {
    let mask = |enabled: bool, adjust: Value| {
        json!({
            "id": "inert", "kind": "radial", "enabled": enabled,
            "center": {"x": 0.5, "y": 0.5}, "radius": {"x": 0.3, "y": 0.3},
            "angle": 0, "feather": 50, "adjust": adjust
        })
    };
    // Off the photo: a plane of zeros.
    let away = json!({
        "id": "away", "kind": "linear",
        "zero": {"x": 0.5, "y": 1.5}, "full": {"x": 0.5, "y": 2},
        "adjust": {"exposure": 1}
    });
    for (name, photo) in Photo::all() {
        let base = photo.base();
        let plain = settings(&base, json!({}));
        for inert in [
            mask(false, json!({"exposure": 1})),
            mask(true, json!({})),
            away.clone(),
        ] {
            let with = settings(&base, json!({ "masks": [inert.clone()] }));
            for (quality, size) in [(Quality::Final, 0usize), (Quality::Interactive, 40)] {
                let expected = photo.open().render(&plain, size, quality).unwrap();
                let mut session = photo.open();
                assert_eq!(
                    session.render(&with, size, quality).unwrap().rgba,
                    expected.rgba,
                    "{name} {inert} {quality:?}"
                );
                assert_eq!(
                    session.render(&plain, size, quality).unwrap().rgba,
                    expected.rgba,
                    "{name} {quality:?}: after the inert mask"
                );
            }
        }
    }
    // The one-shot raster path, whose unmasked frame skips the Session.
    let png = photo_png(120, 80);
    let options = RenderOptions {
        max_dimension: 64,
        ..Default::default()
    };
    let base = Photo::Raster(Vec::new()).base();
    let plain = settings(&base, json!({}));
    let expected = render(&png, &plain.to_json(), &options).unwrap();
    for inert in [mask(false, json!({"exposure": 1})), away] {
        let with = settings(&base, json!({ "masks": [inert] }));
        assert_eq!(
            render(&png, &with.to_json(), &options).unwrap().rgba,
            expected.rgba
        );
    }
}

#[test]
fn a_mask_plane_has_the_render_size_and_the_blend_s_weights() {
    let png = photo_png(120, 80);
    let base = json!({"v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null});
    let mask = json!({
        "id": "spot", "kind": "radial", "invert": true, "enabled": false,
        "center": {"x": 0.4, "y": 0.4}, "radius": {"x": 0.2, "y": 0.3},
        "angle": 10, "feather": 50, "adjust": {"exposure": -1}
    });
    let s = settings(
        &base,
        json!({ "masks": [mask], "geometry": {"angle": 5, "crop": {"left": 0.1, "top": 0.1, "right": 0.9, "bottom": 0.9}} }),
    );
    let session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    for size in [0usize, 50] {
        let (w, h, plane) = session.mask_plane(&s, "spot", size).unwrap();
        assert_eq!(
            (w, h),
            niho_develop::output_size(&s, 120, 80, size).unwrap()
        );
        assert_eq!(plane.len(), w * h);
        // Inverted: the centre of the spot is 0, a corner of the frame 255.
        assert_eq!(plane[0], 255);
        assert!(plane.contains(&0));
    }
    assert!(matches!(
        session.mask_plane(&s, "other", 0),
        Err(niho_develop::Error::MaskNotFound(id)) if id == "other"
    ));
}
