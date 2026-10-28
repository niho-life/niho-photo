//! The screen's pixels stay (#133): the full-size export follows its
//! screen through the fringe radius, the chromatic aberration's analysis
//! image and the other effects tied to the image size, and every render at
//! the screen's sizes (long edge 2560 and below: the editor, the preset
//! previews, the thumbnails) keeps its bytes. The hashes were taken before
//! those changes, on a photo with purple fringes, a lateral chromatic
//! aberration, a wire to heal, a brush mask and sharpening, as a raster
//! (`niho-14`) and as a signed RAW working copy (`niho-11`).

use niho_develop::decode::encode_signed_working_copy;
use niho_develop::mask_surface::{self, MaskSurface};
use niho_develop::{encode, DevelopSettings, Filter, LinearImage, Quality, Session};
use serde_json::{json, Value};

fn lattice(ix: i64, iy: i64) -> f64 {
    let mut z = (ix as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ (iy as u64).wrapping_mul(0xc2b2_ae3d_27d4_eb4f);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
}

/// Linear sRGB of the photo at `(x, y)` on a `w x h` frame: dark branches
/// with purple fringes over a sky, grass below, a wire, and red / blue
/// magnified by 1.0006 / 0.9995 about the center.
fn pixel(w: f64, h: f64, x: f64, y: f64) -> [f64; 3] {
    let (cx, cy) = (w / 2.0, h / 2.0);
    let channel = |s: f64, c: usize| {
        let (x, y) = (cx + (x - cx) / s, cy + (y - cy) / s);
        let d = (0..7)
            .map(|k| {
                let (sn, cs) = (0.41 * k as f64 + 0.3).sin_cos();
                let offset = ((k as f64 * 0.173) % 0.8 - 0.4) * w;
                ((x - cx) * cs + (y - cy) * sn - offset).abs()
            })
            .fold(f64::INFINITY, f64::min)
            - 0.003 * w;
        let dark = 1.0 / (1.0 + (d / 0.6).exp());
        let ground = if y < 0.5 * h {
            0.62 + 0.16 * y / h
        } else {
            let n = lattice((x / 4.0) as i64, (y / 4.0) as i64);
            [0.06, 0.13, 0.04][c] * (0.6 + 0.8 * n)
        };
        let fringe = 0.85 * (-d.max(0.0) / 2.0).exp() * [0.0, -0.6, 0.35][c];
        let wire = {
            let (ax, ay, dx, dy) = (0.1 * w, 0.6 * h, 0.8 * w, 0.2 * h);
            let t = (((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
            let d = (x - ax - t * dx).hypot(y - ay - t * dy);
            1.0 / (1.0 + ((d - 1.5) / 0.6).exp())
        };
        let lit = ground * (1.0 + fringe);
        ((1.0 - dark) * lit + dark * 0.03) * (1.0 - wire) + wire * 0.01
    };
    [channel(1.0006, 0), channel(1.0, 1), channel(0.9995, 2)]
}

fn linear(w: usize, h: usize) -> LinearImage {
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let p = pixel(w as f64, h as f64, x as f64 + 0.5, y as f64 + 0.5);
            data.extend(p.map(|v| v as f32));
        }
    }
    LinearImage {
        width: w,
        height: h,
        data,
    }
}

fn png(w: usize, h: usize) -> Vec<u8> {
    let image = linear(w, h);
    let to8 = |v: f32| {
        let v = v.clamp(0.0, 1.0) as f64;
        let e = if v <= 0.003_130_8 {
            12.92 * v
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        };
        (e * 255.0).round() as u8
    };
    let rgba: Vec<u8> = image
        .data
        .chunks_exact(3)
        .flat_map(|p| [to8(p[0]), to8(p[1]), to8(p[2]), 255])
        .collect();
    encode::encode_png(&rgba, w, h).unwrap()
}

/// A brush surface of 1024 px: a disc with the editor's 1-pixel edge.
fn surface(aspect: f64) -> (String, Vec<u8>, u32, u32) {
    let (sw, sh) = (1024u32, (1024.0 / aspect).round() as u32);
    let (cx, cy, r) = (0.35 * sw as f64, 0.55 * sh as f64, 0.3 * sh as f64);
    let data = (0..sh)
        .flat_map(|y| (0..sw).map(move |x| (x, y)))
        .map(|(x, y)| {
            let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
            let t = (r + 0.5 - d).clamp(0.0, 1.0);
            (255.0 * t * t * (3.0 - 2.0 * t)).round() as u8
        })
        .collect();
    let png = mask_surface::encode_surface_png(&MaskSurface::new(sw, sh, data).unwrap()).unwrap();
    (mask_surface::surface_id(&png), png, sw, sh)
}

fn settings(base: Value, surface: &(String, Vec<u8>, u32, u32)) -> DevelopSettings {
    let mut v = base;
    v["lens"] = json!({
        "removeChromaticAberration": true,
        "defringe": {"purple": {"amount": 100}, "green": {"amount": 60}}
    });
    v["heal"] = json!([{"id": "w", "mode": "remove", "radius": 0.004, "feather": 0.5,
        "points": [[0.1, 0.6], [0.5, 0.7], [0.9, 0.8]]}]);
    v["detail"] = json!({"sharpening": {"amount": 60, "radius": 1.2, "detail": 25, "masking": 10},
        "luminanceNoiseReduction": 10, "colorNoiseReduction": 25});
    v["masks"] = json!([{"id": "b", "kind": "brush",
        "surface": {"id": surface.0, "width": surface.2, "height": surface.3},
        "adjust": {"exposure": 0.6, "clarity": 20}}]);
    v["clarity"] = json!(15);
    v["texture"] = json!(10);
    let mut s = DevelopSettings::from_value(&v).unwrap();
    s.v = s.required_version().max(s.v);
    assert!(s.validate().is_empty(), "{:?}", s.validate());
    s
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// `(size, hash)` of the renders a screen makes of `session`.
fn renders(session: &mut Session, s: &DevelopSettings) -> Vec<String> {
    [
        (0, Quality::Final),
        (1280, Quality::Final),
        (640, Quality::Interactive),
    ]
    .into_iter()
    .map(|(m, q)| {
        let r = session.render(s, m, q).unwrap();
        format!("{}x{}:{:016x}", r.width, r.height, fnv1a64(&r.rgba))
    })
    .collect()
}

#[test]
fn the_screen_sizes_render_as_before() {
    let surface = surface(1.5);
    let raster = settings(json!({"engine": "niho-14"}), &surface);
    let mut hashes = Vec::new();
    // A working image of 2560 px, and the screen of a larger photo.
    for (w, h, working) in [(2560usize, 1707usize, 0usize), (3000, 2000, 2560)] {
        let mut session = Session::open_raster(&png(w, h), working, Filter::Lanczos3).unwrap();
        session.set_mask_surface(&surface.0, &surface.1).unwrap();
        hashes.extend(renders(&mut session, &raster));
    }
    let (image_png, encoding) = encode_signed_working_copy(&linear(2560, 1707)).unwrap();
    let meta = format!(
        r#"{{"kind":"raw","baselineEV":-0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":0}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    let mut session = Session::open_working_copy(&image_png, &meta, Filter::Lanczos3).unwrap();
    session.set_mask_surface(&surface.0, &surface.1).unwrap();
    let raw = settings(
        json!({"engine": "niho-11", "look": "niho-standard-5", "base": null, "exposure": -0.2}),
        &surface,
    );
    hashes.extend(renders(&mut session, &raw));
    println!("{}", json!(hashes));
    assert_eq!(hashes, EXPECTED);
}

const EXPECTED: [&str; 9] = [""; 9];
