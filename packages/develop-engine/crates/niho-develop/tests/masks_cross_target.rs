//! Local masks render the same bytes natively and in browser wasm
//! (`docs/local-adjustments.md` "面の式": the planes use IEEE `+ - * / sqrt`
//! in `f32` and one `libm` sine / cosine per mask; the blend is integer).
//! This test runs on both targets and pins the RGBA hashes of a synthetic
//! photo with a linear and a radial mask under a turned, straightened crop,
//! as a released frame (the one-shot render) and a drag frame (a Session),
//! and of the overlay plane. A second test does the same for a brush mask
//! whose surface (a synthetic 8-bit gray PNG made here) a Session holds
//! (`docs/local-adjustments.md` "面の受け渡し", M4 #68): the PNG's bytes and
//! id, the released and drag frames, the exported PNG and the plane.

use niho_develop::mask_surface::{self, MaskSurface};
use niho_develop::{encode, parse_settings, render, Filter, Quality, RenderOptions, Session};

fn photo() -> Vec<u8> {
    let (w, h) = (160usize, 120usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    let mut state = 0x6d2b_79f5u32;
    for y in 0..h {
        for x in 0..w {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 7) as i32 - 3;
            // A sky over a dark field with a saturated object.
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

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

const SETTINGS: &str = r#"{"v":5,"engine":"niho-10","look":"niho-standard-1","base":null,"shadows":25,"vibrance":10,
"geometry":{"rotate":90,"angle":3.5,"crop":{"left":0.05,"top":0.08,"right":0.93,"bottom":0.95}},
"masks":[
 {"id":"sky","kind":"linear","zero":{"x":0.5,"y":0.45},"full":{"x":0.52,"y":0.1},"adjust":{"exposure":-0.9,"highlights":-40,"saturation":15}},
 {"id":"object","kind":"radial","invert":true,"center":{"x":0.62,"y":0.66},"radius":{"x":0.2,"y":0.25},"angle":-25,"feather":45,"adjust":{"clarity":30,"relativeTemperature":-20,"hsl":["red",{"saturation":-30}]}}
]}"#;

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_masked_bytes() {
    let input = photo();
    let settings = parse_settings(SETTINGS).unwrap();
    let released = render(
        &input,
        SETTINGS,
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap();
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let drag = session.render(&settings, 96, Quality::Interactive).unwrap();
    let (w, h, plane) = session.mask_plane(&settings, "object", 96).unwrap();
    assert_eq!((released.width, released.height), (110, 128));
    assert_eq!((drag.width, drag.height), (w, h));
    assert_eq!(
        [
            fnv1a64(&released.rgba),
            fnv1a64(&drag.rgba),
            fnv1a64(&plane)
        ],
        [
            14_224_716_338_317_839_401,
            12_440_713_395_875_544_195,
            2_411_968_078_102_423_582
        ]
    );
}

/// A drag of a global slider (Vibrance) under the masks of [`SETTINGS`]
/// (`docs/local-adjustments.md` "層の持ち方", #92): the first frame draws
/// the layers (a new Session's frame), the next ones are `R0` plus the
/// first frame's differences of the layers, `clamp(R0 + sum_k ((R_k^a -
/// R0^a) * w_k + 32768) >> 16)`, written out here from each layer drawn
/// alone and its plane. The same bytes on both targets.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_reuse_the_same_layer_differences_in_a_global_drag() {
    use niho_develop::local_render::{self, SourceMap};
    let input = photo();
    let open = || Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let at = |vibrance: f64| {
        let mut s = parse_settings(SETTINGS).unwrap();
        s.vibrance = vibrance;
        s
    };
    let q = Quality::Interactive;
    let mut session = open();
    let mut global = open();
    let anchor = at(10.0);
    let first = session.render(&anchor, 96, q).unwrap();
    assert_eq!(first.rgba, open().render(&anchor, 96, q).unwrap().rgba);
    let r0_anchor = global
        .render(&local_render::without_masks(&anchor), 96, q)
        .unwrap();
    let (w, h) = (first.width, first.height);
    let map = SourceMap::new(anchor.geometry.as_ref(), 160, 120).unwrap();
    let layers: Vec<(Vec<u8>, Vec<u32>)> = anchor
        .masks
        .iter()
        .map(|mask| {
            let local =
                local_render::local_settings(&local_render::without_masks(&anchor), &mask.adjust);
            let rk = open().render(&local, 96, q).unwrap();
            let weights = local_render::mask_weights(mask, &map, w, h, None).unwrap();
            (rk.rgba, weights)
        })
        .collect();
    let mut hashes = vec![fnv1a64(&first.rgba)];
    for vibrance in [14.0, 18.0, 22.0] {
        let frame = session.render(&at(vibrance), 96, q).unwrap();
        let r0 = global
            .render(&local_render::without_masks(&at(vibrance)), 96, q)
            .unwrap();
        let mut expected = r0.rgba.clone();
        for p in 0..w * h {
            for c in 0..3 {
                let mut acc = i32::from(r0.rgba[p * 4 + c]);
                for (rgba, weights) in &layers {
                    let diff = i32::from(rgba[p * 4 + c]) - i32::from(r0_anchor.rgba[p * 4 + c]);
                    acc += (diff * weights[p] as i32 + 32768) >> 16;
                }
                expected[p * 4 + c] = acc.clamp(0, 255) as u8;
            }
        }
        assert_eq!(frame.rgba, expected, "{vibrance}");
        hashes.push(fnv1a64(&frame.rgba));
    }
    // Released: the exact Final frame.
    let released = session.render(&at(22.0), 0, Quality::Final).unwrap();
    assert_eq!(
        released.rgba,
        open().render(&at(22.0), 0, Quality::Final).unwrap().rgba
    );
    hashes.push(fnv1a64(&released.rgba));
    assert_eq!(
        hashes,
        [
            12_440_713_395_875_544_195,
            9_714_812_268_290_276_759,
            4_067_884_575_321_943_044,
            6_869_771_056_534_690_060,
            2_590_382_600_995_111_407
        ]
    );
}

/// A soft painted stroke with a hard spot (every value 0..=255 appears).
fn surface_png() -> Vec<u8> {
    let (w, h) = (73u32, 41u32);
    let data = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| {
            let stroke = (x as i32 * 3 - y as i32 * 5 - 40).unsigned_abs() as f64;
            let soft = (255.0 - stroke * 6.0).clamp(0.0, 255.0) as u8;
            let spot = (x as i32 - 55).pow(2) + (y as i32 - 12).pow(2) < 40;
            if spot {
                255
            } else {
                soft
            }
        })
        .collect();
    mask_surface::encode_surface_png(&MaskSurface::new(w, h, data).unwrap()).unwrap()
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_surfaced_bytes() {
    let input = photo();
    let png = surface_png();
    let id = mask_surface::surface_id(&png);
    let text = format!(
        r#"{{"v":5,"engine":"niho-10","look":"niho-standard-1","base":null,"shadows":25,
"geometry":{{"rotate":270,"angle":-2.5,"crop":{{"left":0.04,"top":0.06,"right":0.95,"bottom":0.9}}}},
"masks":[
 {{"id":"sky","kind":"linear","zero":{{"x":0.5,"y":0.45}},"full":{{"x":0.52,"y":0.1}},"adjust":{{"exposure":-0.6}}}},
 {{"id":"paint","kind":"brush","surface":{{"id":"{id}","width":73,"height":41}},"adjust":{{"exposure":0.8,"saturation":-35,"clarity":20}}}}
]}}"#
    );
    let settings = parse_settings(&text).unwrap();
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    session.set_mask_surface(&id, &png).unwrap();
    let released = session.render(&settings, 0, Quality::Final).unwrap();
    let exported = session.export_png(&settings, 0).unwrap();
    let drag = session.render(&settings, 96, Quality::Interactive).unwrap();
    let (w, h, plane) = session.mask_plane(&settings, "paint", 96).unwrap();
    assert_eq!((drag.width, drag.height), (w, h));
    assert!(plane.contains(&0) && plane.contains(&255));
    assert_eq!(
        [
            fnv1a64(&png),
            fnv1a64(&released.rgba),
            fnv1a64(&exported),
            fnv1a64(&drag.rgba),
            fnv1a64(&plane)
        ],
        [
            9_734_754_401_130_926_224,
            17_735_939_846_036_810_453,
            6_524_484_371_947_961_774,
            13_475_127_805_575_395_793,
            3_389_071_474_784_361_943
        ]
    );
    assert_eq!(
        id,
        "57ba7449db4404f2fc716326fa11de7196f123d6559f2a3d0f42ee6f26f6965a"
    );
}
