//! The CLI draws the same pixels as the crate's calls it stands for
//! (`niho_develop::render` for an original, `Session` for a working copy),
//! writes an 8-bit RGB PNG without ICC, and reports failures as one JSON line
//! with a fixed exit code.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use niho_develop::decode::{self, LinearImage};
use niho_develop::settings::{
    ENGINE_NIHO_3, ENGINE_NIHO_4, LOOK_NIHO_STANDARD_2, LOOK_NIHO_STANDARD_3,
};
use niho_develop::{DevelopSettings, Filter, Quality, RenderOptions, Session};
use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_niho-develop-render");
const WC_BASE: &str = "raw-apple.d8.p2.e1.cal-panasonic-dc-s5-apple-v2.lens-apple";
const SIGNED_WC_BASE: &str = "raw-apple.d8.p3.e4.cal-none.lens-apple";

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "niho-develop-render-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn write(&self, name: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
        let path = self.path(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    /// Files other than `keep` (a failed run must leave no partial output).
    fn others(&self, keep: &[&Path]) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.0)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| !keep.contains(&p.as_path()))
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Run {
    code: i32,
    stdout: String,
}

impl Run {
    /// The single stdout line as JSON.
    fn json(&self) -> Value {
        let lines: Vec<&str> = self.stdout.lines().collect();
        assert_eq!(lines.len(), 1, "one stdout line: {:?}", self.stdout);
        serde_json::from_str(lines[0]).unwrap()
    }
}

fn run(args: &[&str]) -> Run {
    let output = Command::new(BIN).args(args).output().unwrap();
    Run {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8(output.stdout).unwrap(),
    }
}

fn s(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn golden_jpeg() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/golden/input/dsc02072.jpg")
}

/// A settings with the local controls, the cubes and the curve all active.
fn settings(base: Option<&str>) -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.base = base.map(str::to_string);
    s.exposure = 0.35;
    s.contrast = 18.0;
    s.highlights = -40.0;
    s.shadows = 35.0;
    s.clarity = 12.0;
    s.vibrance = 20.0;
    s
}

fn working_copy() -> Vec<u8> {
    let (w, h) = (120usize, 80usize);
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let t = x as f32 / (w - 1) as f32;
            let u = y as f32 / (h - 1) as f32;
            data.extend_from_slice(&[
                0.02 + 0.9 * t * t,
                0.04 + 0.5 * u,
                0.1 + 0.4 * (1.0 - t) * u,
            ]);
        }
    }
    decode::encode_working_copy(&LinearImage {
        width: w,
        height: h,
        data,
    })
}

const META: &str = r#"{"kind":"raw","baselineEV":0.1,"asShotWhite":{"x":0.3324,"y":0.3474,"temperature":5400,"tint":4},"asShotWhiteAdobe":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v2","lookTableIncluded":false}"#;

fn signed_working_copy() -> (Vec<u8>, String) {
    let image = LinearImage {
        width: 4,
        height: 2,
        data: vec![
            -0.1, 0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 0.1, 0.3, 0.5, 0.7, -0.2, 0.1, 0.4, 0.6, 0.8,
            1.1, 0.0, 0.2, 0.5, 0.9, 1.3, 1.8,
        ],
    };
    let (png, encoding) = decode::encode_signed_working_copy(&image).unwrap();
    let meta = format!(
        r#"{{"kind":"raw","baselineEV":0.1,"asShotWhite":{{"x":0.3324,"y":0.3474,"temperature":5400,"tint":4}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"fixture","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    (png, meta)
}

/// The PNG's RGB8 pixels; it must be 8-bit RGB without an ICC profile.
fn read_png(path: &Path) -> (usize, usize, Vec<u8>) {
    let bytes = fs::read(path).unwrap();
    assert!(
        !bytes.windows(4).any(|w| w == b"iCCP"),
        "the PNG carries no ICC profile"
    );
    let image = image::load_from_memory(&bytes).unwrap();
    let image::DynamicImage::ImageRgb8(rgb) = image else {
        panic!("expected an 8-bit RGB PNG, got {:?}", image.color());
    };
    (rgb.width() as usize, rgb.height() as usize, rgb.into_raw())
}

fn rgb_of(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect()
}

#[test]
fn an_original_matches_the_crates_one_shot_render() {
    let dir = TempDir::new("raster");
    let settings = settings(None);
    let settings_path = dir.write("settings.json", settings.to_json());
    let out = dir.path("out.png");
    let result = run(&[
        "render",
        "--settings",
        s(&settings_path),
        "--raster",
        s(&golden_jpeg()),
        "--max-dimension",
        "320",
        "--out",
        s(&out),
    ]);
    assert_eq!(result.code, 0, "{}", result.stdout);
    let summary = result.json();

    let input = fs::read(golden_jpeg()).unwrap();
    let options = RenderOptions {
        max_dimension: 320,
        quality: Quality::Final,
        filter: Filter::Lanczos3,
        decode_cap: 0,
    };
    let expected = niho_develop::render(&input, &settings.to_json(), &options).unwrap();
    let (w, h, rgb) = read_png(&out);
    assert_eq!((w, h), (expected.width, expected.height));
    assert_eq!(rgb, rgb_of(&expected.rgba), "same pixels as the crate");

    assert_eq!(summary["width"], w);
    assert_eq!(summary["height"], h);
    assert_eq!(summary["source"], "raster");
    assert_eq!(summary["engine"], "niho-1");
    assert_eq!(summary["settingsBase"], Value::Null);
    assert_eq!(summary["sourceBase"], Value::Null);
    assert_eq!(summary["baseMismatch"], false);
    assert_eq!(summary["bytes"], fs::metadata(&out).unwrap().len());
    assert!(summary["renderMs"].as_f64().unwrap() >= 0.0);
    assert_eq!(dir.others(&[&settings_path, &out]), Vec::<String>::new());
}

#[test]
fn a_working_copy_matches_the_session_render_at_its_size_and_reduced() {
    let dir = TempDir::new("working-copy");
    let png = working_copy();
    let settings = settings(Some(WC_BASE));
    let settings_path = dir.write("settings.json", settings.to_json());
    let wc_path = dir.write("working.png", &png);
    let meta_path = dir.write("working.json", META);

    for max_dimension in [0usize, 48] {
        let out = dir.path(&format!("out-{max_dimension}.png"));
        let result = run(&[
            "render",
            "--settings",
            s(&settings_path),
            "--working-copy",
            s(&wc_path),
            "--meta",
            s(&meta_path),
            "--base-version",
            WC_BASE,
            &format!("--max-dimension={max_dimension}"),
            "--out",
            s(&out),
        ]);
        assert_eq!(result.code, 0, "{}", result.stdout);
        let summary = result.json();

        let mut session = Session::open_working_copy(&png, META, Filter::Lanczos3).unwrap();
        let expected = session
            .render(&settings, max_dimension, Quality::Final)
            .unwrap();
        let (w, h, rgb) = read_png(&out);
        assert_eq!((w, h), (expected.width, expected.height));
        assert_eq!(rgb, rgb_of(&expected.rgba), "max {max_dimension}");
        assert_eq!(summary["source"], "workingCopy");
        assert_eq!(summary["settingsBase"], WC_BASE);
        assert_eq!(summary["sourceBase"], WC_BASE);
        assert_eq!(summary["baseMismatch"], false);
    }
    assert_eq!((read_png(&dir.path("out-48.png")).0), 48);
}

#[test]
fn a_signed_working_copy_with_niho3_is_accepted_without_a_private_photo() {
    let dir = TempDir::new("signed-niho3");
    let (png, meta) = signed_working_copy();
    let png_path = dir.write("working.png", png);
    let meta_path = dir.write("working.json", meta);
    let mut settings = DevelopSettings::new_edit();
    settings.engine = ENGINE_NIHO_3.into();
    settings.look = LOOK_NIHO_STANDARD_2.into();
    settings.base = Some(SIGNED_WC_BASE.into());
    let settings_path = dir.write("settings.json", settings.to_json());
    let out = dir.path("out.png");

    let result = run(&[
        "render",
        "--settings",
        s(&settings_path),
        "--working-copy",
        s(&png_path),
        "--meta",
        s(&meta_path),
        "--base-version",
        SIGNED_WC_BASE,
        "--out",
        s(&out),
    ]);

    assert_eq!(result.code, 0, "{}", result.stdout);
    assert_eq!(result.json()["engine"], ENGINE_NIHO_3);
    assert_eq!((read_png(&out).0, read_png(&out).1), (4, 2));
}

#[test]
fn a_supported_signed_working_copy_with_niho4_is_accepted_without_a_private_photo() {
    let dir = TempDir::new("signed-niho4");
    let (png, meta) = signed_working_copy();
    let meta = meta.replace(
        "\"fixture\"",
        "\"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4\"",
    );
    let png_path = dir.write("working.png", png);
    let meta_path = dir.write("working.json", meta);
    let mut settings = DevelopSettings::new_edit();
    settings.engine = ENGINE_NIHO_4.into();
    settings.look = LOOK_NIHO_STANDARD_3.into();
    settings.base = Some(SIGNED_WC_BASE.into());
    settings.highlights = -40.0;
    settings.shadows = 30.0;
    let settings_path = dir.write("settings.json", settings.to_json());
    let out = dir.path("out.png");

    let result = run(&[
        "render",
        "--settings",
        s(&settings_path),
        "--working-copy",
        s(&png_path),
        "--meta",
        s(&meta_path),
        "--base-version",
        SIGNED_WC_BASE,
        "--out",
        s(&out),
    ]);

    assert_eq!(result.code, 0, "{}", result.stdout);
    assert_eq!(result.json()["engine"], ENGINE_NIHO_4);
    assert_eq!((read_png(&out).0, read_png(&out).1), (4, 2));
}

/// `settings` with a geometry (`v: 2`).
fn with_geometry(settings: &DevelopSettings, geometry: &str) -> DevelopSettings {
    let mut v = settings.to_value();
    v["v"] = 2.into();
    v["geometry"] = serde_json::from_str(geometry).unwrap();
    DevelopSettings::from_json(&v.to_string()).unwrap()
}

#[test]
fn a_geometry_is_rendered_cropped() {
    let dir = TempDir::new("geometry");
    // An original: turned a quarter clockwise (800 x 1200), then cropped
    // to 640 x 600, at 320px: decoded at 600px (not 320) for the crop.
    let raster_settings = with_geometry(
        &settings(None),
        r#"{"rotate":90,"crop":{"left":0.1,"top":0.2,"right":0.9,"bottom":0.7}}"#,
    );
    let settings_path = dir.write("settings.json", raster_settings.to_json());
    let out = dir.path("raster.png");
    let result = run(&[
        "render",
        "--settings",
        s(&settings_path),
        "--raster",
        s(&golden_jpeg()),
        "--max-dimension",
        "320",
        "--out",
        s(&out),
    ]);
    assert_eq!(result.code, 0, "{}", result.stdout);
    let input = fs::read(golden_jpeg()).unwrap();
    let expected = niho_develop::render(
        &input,
        &raster_settings.to_json(),
        &RenderOptions {
            max_dimension: 320,
            quality: Quality::Final,
            filter: Filter::Lanczos3,
            decode_cap: 0,
        },
    )
    .unwrap();
    let (w, h, rgb) = read_png(&out);
    assert_eq!((w, h), (320, 300));
    assert_eq!((w, h), (expected.width, expected.height));
    assert_eq!(rgb, rgb_of(&expected.rgba), "same pixels as the crate");
    assert_eq!(result.json()["width"], 320);

    // A working copy, straightened: the session's frame at its size.
    let png = working_copy();
    let wc_settings = with_geometry(
        &settings(Some(WC_BASE)),
        r#"{"angle":2,"flipH":true,"crop":{"left":0.1,"top":0.1,"right":0.8,"bottom":0.95}}"#,
    );
    let settings_path = dir.write("settings-wc.json", wc_settings.to_json());
    let wc_path = dir.write("working.png", &png);
    let meta_path = dir.write("working.json", META);
    for max_dimension in [0usize, 48] {
        let out = dir.path(&format!("wc-{max_dimension}.png"));
        let result = run(&[
            "render",
            "--settings",
            s(&settings_path),
            "--working-copy",
            s(&wc_path),
            "--meta",
            s(&meta_path),
            "--base-version",
            WC_BASE,
            &format!("--max-dimension={max_dimension}"),
            "--out",
            s(&out),
        ]);
        assert_eq!(result.code, 0, "{}", result.stdout);
        let expected = Session::open_working_copy(&png, META, Filter::Lanczos3)
            .unwrap()
            .render(&wc_settings, max_dimension, Quality::Final)
            .unwrap();
        let size = niho_develop::output_size(&wc_settings, 120, 80, max_dimension).unwrap();
        let (w, h, rgb) = read_png(&out);
        assert_eq!((w, h), size);
        assert!(w < 120 * 8 / 10 + 1 && h < 80);
        assert_eq!(rgb, rgb_of(&expected.rgba), "max {max_dimension}");
        if max_dimension > 0 {
            assert_eq!(w.max(h), max_dimension);
        }
    }
}

/// `settings` with a linear and a radial local mask (`v: 5`) and `geometry`.
fn with_masks(settings: &DevelopSettings, geometry: Option<&str>) -> DevelopSettings {
    let mut v = settings.to_value();
    v["v"] = 5.into();
    if let Some(geometry) = geometry {
        v["geometry"] = serde_json::from_str(geometry).unwrap();
    }
    v["masks"] = serde_json::json!([
        {
            "id": "sky", "kind": "linear",
            "zero": {"x": 0.5, "y": 0.6}, "full": {"x": 0.5, "y": 0.1},
            "adjust": {"exposure": -0.8, "highlights": -30}
        },
        {
            "id": "face", "kind": "radial", "invert": true,
            "center": {"x": 0.45, "y": 0.55}, "radius": {"x": 0.3, "y": 0.25},
            "angle": 20, "feather": 60,
            "adjust": {"saturation": -40, "clarity": 25}
        }
    ]);
    DevelopSettings::from_json(&v.to_string()).unwrap()
}

#[test]
fn local_masks_match_the_crates_render() {
    let dir = TempDir::new("masks");
    // An original, turned and cropped: the crate's one-shot render.
    let raster_settings = with_masks(
        &settings(None),
        Some(r#"{"rotate":90,"crop":{"left":0.1,"top":0.2,"right":0.9,"bottom":0.7}}"#),
    );
    let settings_path = dir.write("settings.json", raster_settings.to_json());
    let out = dir.path("raster.png");
    let result = run(&[
        "render",
        "--settings",
        s(&settings_path),
        "--raster",
        s(&golden_jpeg()),
        "--max-dimension",
        "320",
        "--out",
        s(&out),
    ]);
    assert_eq!(result.code, 0, "{}", result.stdout);
    let input = fs::read(golden_jpeg()).unwrap();
    let options = RenderOptions {
        max_dimension: 320,
        quality: Quality::Final,
        filter: Filter::Lanczos3,
        decode_cap: 0,
    };
    let expected = niho_develop::render(&input, &raster_settings.to_json(), &options).unwrap();
    let (w, h, rgb) = read_png(&out);
    assert_eq!((w, h), (expected.width, expected.height));
    assert_eq!(rgb, rgb_of(&expected.rgba), "same pixels as the crate");
    let mut unmasked = raster_settings.clone();
    unmasked.masks.clear();
    let plain = niho_develop::render(&input, &unmasked.to_json(), &options).unwrap();
    assert_ne!(plain.rgba, expected.rgba, "the masks change the frame");

    // A working copy: the session's frame at its size and reduced.
    let png = working_copy();
    let wc_settings = with_masks(&settings(Some(WC_BASE)), None);
    let settings_path = dir.write("settings-wc.json", wc_settings.to_json());
    let wc_path = dir.write("working.png", &png);
    let meta_path = dir.write("working.json", META);
    for max_dimension in [0usize, 48] {
        let out = dir.path(&format!("wc-{max_dimension}.png"));
        let result = run(&[
            "render",
            "--settings",
            s(&settings_path),
            "--working-copy",
            s(&wc_path),
            "--meta",
            s(&meta_path),
            "--base-version",
            WC_BASE,
            &format!("--max-dimension={max_dimension}"),
            "--out",
            s(&out),
        ]);
        assert_eq!(result.code, 0, "{}", result.stdout);
        let expected = Session::open_working_copy(&png, META, Filter::Lanczos3)
            .unwrap()
            .render(&wc_settings, max_dimension, Quality::Final)
            .unwrap();
        let (w, h, rgb) = read_png(&out);
        assert_eq!((w, h), (expected.width, expected.height));
        assert_eq!(rgb, rgb_of(&expected.rgba), "max {max_dimension}");
    }
}

/// A brush surface (a soft diagonal band) and its id.
fn brush_surface() -> (String, Vec<u8>) {
    use niho_develop::mask_surface::{encode_surface_png, surface_id, MaskSurface};
    let (w, h) = (64u32, 40u32);
    let data = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| (255 - (x as i32 * 2 - y as i32 * 3).unsigned_abs().min(255)) as u8)
        .collect();
    let png = encode_surface_png(&MaskSurface::new(w, h, data).unwrap()).unwrap();
    (surface_id(&png), png)
}

/// `settings` with a linear mask and a brush mask of `surface` (`v: 5`).
fn with_brush(settings: &DevelopSettings, id: &str, height: u32) -> DevelopSettings {
    let mut v = settings.to_value();
    v["v"] = 5.into();
    v["masks"] = serde_json::json!([
        {
            "id": "sky", "kind": "linear",
            "zero": {"x": 0.5, "y": 0.6}, "full": {"x": 0.5, "y": 0.1},
            "adjust": {"exposure": -0.8}
        },
        {
            "id": "paint", "kind": "brush",
            "surface": {"id": id, "width": 64, "height": height},
            "adjust": {"exposure": 0.7, "saturation": -40}
        }
    ]);
    DevelopSettings::from_json(&v.to_string()).unwrap()
}

#[test]
fn mask_surfaces_render_like_the_crate_and_fail_with_fixed_codes() {
    let dir = TempDir::new("mask-surfaces");
    let (id, png) = brush_surface();
    let surface_path = dir.write("surface.png", &png);
    let surface_arg = format!("{id}={}", s(&surface_path));
    // An original: the CLI opens it at --max-dimension and renders it at 0.
    let raster_settings = with_brush(&settings(None), &id, 40);
    let settings_path = dir.write("settings.json", raster_settings.to_json());
    let out = dir.path("raster.png");
    let result = run(&[
        "render",
        "--settings",
        s(&settings_path),
        "--raster",
        s(&golden_jpeg()),
        "--max-dimension",
        "200",
        "--mask-surface",
        &surface_arg,
        "--out",
        s(&out),
    ]);
    assert_eq!(result.code, 0, "{}", result.stdout);
    let input = fs::read(golden_jpeg()).unwrap();
    let mut session = Session::open_raster(&input, 200, Filter::Lanczos3).unwrap();
    session.set_mask_surface(&id, &png).unwrap();
    let expected = session.render(&raster_settings, 0, Quality::Final).unwrap();
    let (w, h, rgb) = read_png(&out);
    assert_eq!((w, h), (expected.width, expected.height));
    assert_eq!(rgb, rgb_of(&expected.rgba), "same pixels as the crate");
    let mut without = raster_settings.clone();
    without.masks.truncate(1);
    let plain = Session::open_raster(&input, 200, Filter::Lanczos3)
        .unwrap()
        .render(&without, 0, Quality::Final)
        .unwrap();
    assert_ne!(plain.rgba, expected.rgba, "the brush changes the frame");

    // A working copy, with the --name=value form.
    let wc = working_copy();
    let wc_settings = with_brush(&settings(Some(WC_BASE)), &id, 40);
    let wc_settings_path = dir.write("settings-wc.json", wc_settings.to_json());
    let wc_path = dir.write("working.png", &wc);
    let meta_path = dir.write("working.json", META);
    let wc_out = dir.path("wc.png");
    let result = run(&[
        "render",
        "--settings",
        s(&wc_settings_path),
        "--working-copy",
        s(&wc_path),
        "--meta",
        s(&meta_path),
        "--base-version",
        WC_BASE,
        &format!("--mask-surface={surface_arg}"),
        "--out",
        s(&wc_out),
    ]);
    assert_eq!(result.code, 0, "{}", result.stdout);
    let mut session = Session::open_working_copy(&wc, META, Filter::Lanczos3).unwrap();
    session.set_mask_surface(&id, &png).unwrap();
    let expected = session.render(&wc_settings, 0, Quality::Final).unwrap();
    assert_eq!(read_png(&wc_out).2, rgb_of(&expected.rgba));

    // Failures: one JSON line, the code and exit of the table.
    let wrong_size = dir.write(
        "wrong-size.json",
        with_brush(&settings(None), &id, 41).to_json(),
    );
    let other_id = "0".repeat(64);
    let other_settings = dir.write(
        "other.json",
        with_brush(&settings(None), &other_id, 40).to_json(),
    );
    let rgb_png = dir.write("rgb.png", fs::read(&out).unwrap());
    let rgb_id = niho_develop::mask_surface::surface_id(&fs::read(&rgb_png).unwrap());
    let rgb_settings = dir.write(
        "rgb.json",
        with_brush(&settings(None), &rgb_id, 40).to_json(),
    );
    let fail_out = dir.path("fail.png");
    let jpeg = golden_jpeg();
    let render = |settings: &Path, surfaces: &[&str]| {
        let mut args = vec![
            "render",
            "--settings",
            s(settings),
            "--raster",
            s(&jpeg),
            "--max-dimension",
            "64",
            "--out",
            s(&fail_out),
        ];
        for surface in surfaces {
            args.extend(["--mask-surface", surface]);
        }
        run(&args)
    };
    let missing_file = format!("{id}={}", s(&dir.path("none.png")));
    let wrong_hash = format!("{other_id}={}", s(&surface_path));
    let rgb_arg = format!("{rgb_id}={}", s(&rgb_png));
    let cases: Vec<(&str, Run, &str, i32)> = vec![
        (
            "no surface",
            render(&settings_path, &[]),
            "unsupported_settings",
            2,
        ),
        (
            "another surface",
            render(&settings_path, &[&wrong_hash]),
            "decode_failed",
            5,
        ),
        (
            "the settings' id is not given",
            render(&other_settings, &[&surface_arg]),
            "unsupported_settings",
            2,
        ),
        (
            "not 8-bit gray",
            render(&rgb_settings, &[&rgb_arg]),
            "decode_failed",
            5,
        ),
        (
            "another size",
            render(&wrong_size, &[&surface_arg]),
            "invalid_settings",
            3,
        ),
        (
            "missing file",
            render(&settings_path, &[&missing_file]),
            "input_not_found",
            4,
        ),
        (
            "no '='",
            render(&settings_path, &[&id]),
            "invalid_arguments",
            1,
        ),
        (
            "not an id",
            render(&settings_path, &[&format!("ABC={}", s(&surface_path))]),
            "invalid_arguments",
            1,
        ),
        (
            "no file",
            render(&settings_path, &[&format!("{id}=")]),
            "invalid_arguments",
            1,
        ),
        (
            "the same id twice",
            render(&settings_path, &[&surface_arg, &surface_arg]),
            "invalid_arguments",
            1,
        ),
        (
            "--out is a surface",
            run(&[
                "render",
                "--settings",
                s(&settings_path),
                "--raster",
                s(&golden_jpeg()),
                "--mask-surface",
                &surface_arg,
                "--out",
                s(&surface_path),
            ]),
            "invalid_arguments",
            1,
        ),
    ];
    for (name, result, code, exit) in cases {
        let json = result.json();
        assert_eq!(json["error"], code, "{name}: {}", result.stdout);
        let message = json["message"].as_str().unwrap_or_default();
        assert!(!message.is_empty(), "{name}");
        assert_eq!(result.code, exit, "{name}");
        match name {
            "another surface" | "not 8-bit gray" => {
                assert!(message.starts_with("maskSurfaceInvalid"), "{message}")
            }
            "no surface" | "the settings' id is not given" => {
                assert!(message.starts_with("maskSurfaceMissing"), "{message}")
            }
            "another size" => assert!(message.starts_with("maskSurfaceMismatch"), "{message}"),
            _ => {}
        }
    }
    assert!(!fail_out.exists(), "no output after a failure");
    // More surfaces than masks can use.
    let many: Vec<String> = (0..9)
        .map(|i| format!("{:064x}={}", i, s(&surface_path)))
        .collect();
    let many: Vec<&str> = many.iter().map(String::as_str).collect();
    let result = render(&settings_path, &many);
    assert_eq!(result.json()["error"], "invalid_arguments");
    assert_eq!(result.code, 1);
}

#[test]
fn a_different_base_is_rendered_and_reported() {
    let dir = TempDir::new("base-mismatch");
    let png = working_copy();
    let wc_path = dir.write("working.png", &png);
    // The meta's own baseVersion when --base-version is not given.
    let meta = META.replacen(
        '{',
        r#"{"baseVersion":"raw-apple.d8.p2.e1.cal-none.lens-apple","#,
        1,
    );
    let meta_path = dir.write("working.json", &meta);

    for (base, mismatch) in [
        (Some(WC_BASE), true),
        (None, true),
        (Some("raw-apple.d8.p2.e1.cal-none.lens-apple"), false),
    ] {
        let settings_path = dir.write("settings.json", settings(base).to_json());
        let out = dir.path("out.png");
        let result = run(&[
            "render",
            "--settings",
            s(&settings_path),
            "--working-copy",
            s(&wc_path),
            "--meta",
            s(&meta_path),
            "--out",
            s(&out),
        ]);
        assert_eq!(result.code, 0, "{}", result.stdout);
        let summary = result.json();
        assert_eq!(
            summary["sourceBase"],
            "raw-apple.d8.p2.e1.cal-none.lens-apple"
        );
        assert_eq!(summary["baseMismatch"], mismatch, "settings base {base:?}");
        assert_eq!(read_png(&out).0, 120);
    }

    // An original is its own base (null): settings made on a working copy differ.
    let settings_path = dir.write("settings.json", settings(Some(WC_BASE)).to_json());
    let out = dir.path("raster.png");
    let result = run(&[
        "render",
        "--settings",
        s(&settings_path),
        "--raster",
        s(&golden_jpeg()),
        "--max-dimension",
        "64",
        "--out",
        s(&out),
    ]);
    assert_eq!(result.code, 0, "{}", result.stdout);
    assert_eq!(result.json()["baseMismatch"], true);
}

#[test]
fn failures_are_one_json_line_with_a_fixed_exit_code() {
    let dir = TempDir::new("errors");
    let good = dir.write("settings.json", settings(None).to_json());
    let wc_path = dir.write("working.png", working_copy());
    let meta_path = dir.write("working.json", META);
    let not_an_image = dir.write("not-an-image.jpg", "hello");
    let bad_meta = dir.write("bad-meta.json", r#"{"kind":"dng"}"#);
    let as_file = dir.write("a-file", "x");
    let jpeg = golden_jpeg();
    let out = dir.path("out.png");
    let with = |name: &str, body: &str| dir.write(name, body);
    let no_v = with("no-v.json", r#"{"engine":"niho-1"}"#);
    let no_engine = with("no-engine.json", r#"{"v":1}"#);
    let v6 = with("v6.json", r#"{"v":6,"engine":"niho-1"}"#);
    let v6_out = dir.path("v6-out.png");
    // A brush mask: valid (v 5), but its surface is not given
    // (--mask-surface), so it is never drawn without the mask.
    let masks = with(
        "masks.json",
        &format!(
            r#"{{"v":5,"engine":"niho-1","masks":[{{"id":"b1","kind":"brush","surface":{{"id":"{}","width":8,"height":4}},"adjust":{{"exposure":-0.7}}}}]}}"#,
            "0".repeat(64)
        ),
    );
    let future_settings = format!(
        r#"{{"v":{},"engine":"niho-1"}}"#,
        niho_develop::settings::MAX_SETTINGS_VERSION + 1
    );
    let future_version = with("future-version.json", &future_settings);
    // A turned crop whose corners do not make a rectangle on this photo.
    let crop = with(
        "crop.json",
        r#"{"v":2,"engine":"niho-1","geometry":{"angle":45,"crop":{"left":0,"top":0.5,"right":1,"bottom":0.5}}}"#,
    );
    let crop_v1 = with(
        "crop-v1.json",
        r#"{"v":1,"engine":"niho-1","geometry":{"rotate":90}}"#,
    );
    let look = with("look.json", r#"{"v":1,"engine":"niho-1","look":"niho-11"}"#);
    let range = with("range.json", r#"{"v":1,"engine":"niho-1","exposure":99}"#);
    let types = with("types.json", r#"{"v":1,"engine":"niho-1","exposure":"1"}"#);
    let not_json = with("not-json.json", "{");
    let missing = dir.path("missing.jpg");
    let nested = dir.path("a-file/out.png");

    let raster = |settings: &Path, input: &Path, out: &Path| {
        run(&[
            "render",
            "--settings",
            s(settings),
            "--raster",
            s(input),
            "--max-dimension",
            "64",
            "--out",
            s(out),
        ])
    };
    let cases: Vec<(&str, Run, &str, i32)> = vec![
        ("unknown subcommand", run(&["draw"]), "invalid_arguments", 1),
        (
            "no --out",
            run(&["render", "--settings", s(&good), "--raster", s(&jpeg)]),
            "invalid_arguments",
            1,
        ),
        (
            "unknown option",
            run(&["render", "--quality", "90"]),
            "invalid_arguments",
            1,
        ),
        (
            "both sources",
            run(&[
                "render",
                "--settings",
                s(&good),
                "--out",
                s(&out),
                "--raster",
                s(&jpeg),
                "--working-copy",
                s(&wc_path),
                "--meta",
                s(&meta_path),
            ]),
            "invalid_arguments",
            1,
        ),
        (
            "no source",
            run(&["render", "--settings", s(&good), "--out", s(&out)]),
            "invalid_arguments",
            1,
        ),
        (
            "--meta with a raster",
            run(&[
                "render",
                "--settings",
                s(&good),
                "--out",
                s(&out),
                "--raster",
                s(&jpeg),
                "--meta",
                s(&meta_path),
            ]),
            "invalid_arguments",
            1,
        ),
        (
            "working copy without a base",
            run(&[
                "render",
                "--settings",
                s(&good),
                "--out",
                s(&out),
                "--working-copy",
                s(&wc_path),
                "--meta",
                s(&meta_path),
            ]),
            "invalid_arguments",
            1,
        ),
        (
            "bad --max-dimension",
            run(&[
                "render",
                "--settings",
                s(&good),
                "--out",
                s(&out),
                "--raster",
                s(&jpeg),
                "--max-dimension",
                "-1",
            ]),
            "invalid_arguments",
            1,
        ),
        (
            "--out is an input",
            raster(&good, &jpeg, &jpeg),
            "invalid_arguments",
            1,
        ),
        (
            "--out is a folder",
            raster(&good, &jpeg, &dir.0),
            "invalid_arguments",
            1,
        ),
        (
            "no v",
            raster(&no_v, &jpeg, &out),
            "unsupported_settings",
            2,
        ),
        (
            "no engine",
            raster(&no_engine, &jpeg, &out),
            "unsupported_settings",
            2,
        ),
        // Saved and valid (v 5), but not drawn until M4 (#68): never a frame
        // without the brush surface.
        (
            "a brush mask without its surface",
            raster(&masks, &jpeg, &out),
            "unsupported_settings",
            2,
        ),
        (
            "future version",
            raster(&future_version, &jpeg, &out),
            "unsupported_settings",
            2,
        ),
        (
            "turned crop that is not a rectangle",
            raster(&crop, &jpeg, &out),
            "invalid_settings",
            3,
        ),
        (
            "geometry on v 1",
            raster(&crop_v1, &jpeg, &out),
            "invalid_settings",
            3,
        ),
        (
            "unknown look",
            raster(&look, &jpeg, &out),
            "unsupported_settings",
            2,
        ),
        (
            "out of range",
            raster(&range, &jpeg, &out),
            "invalid_settings",
            3,
        ),
        (
            "wrong type",
            raster(&types, &jpeg, &out),
            "invalid_settings",
            3,
        ),
        (
            "not JSON",
            raster(&not_json, &jpeg, &out),
            "invalid_settings",
            3,
        ),
        (
            "missing settings",
            raster(&dir.path("none.json"), &jpeg, &out),
            "input_not_found",
            4,
        ),
        (
            "missing original",
            raster(&good, &missing, &out),
            "input_not_found",
            4,
        ),
        (
            "not an image",
            raster(&good, &not_an_image, &out),
            "decode_failed",
            5,
        ),
        (
            "bad meta",
            run(&[
                "render",
                "--settings",
                s(&good),
                "--out",
                s(&out),
                "--working-copy",
                s(&wc_path),
                "--meta",
                s(&bad_meta),
                "--base-version",
                WC_BASE,
            ]),
            "invalid_metadata",
            5,
        ),
        (
            "a JPEG as the working copy",
            run(&[
                "render",
                "--settings",
                s(&good),
                "--out",
                s(&out),
                "--working-copy",
                s(&jpeg),
                "--meta",
                s(&meta_path),
                "--base-version",
                WC_BASE,
            ]),
            "decode_failed",
            5,
        ),
        (
            "cannot write",
            raster(&good, &jpeg, &nested),
            "write_failed",
            6,
        ),
    ];
    for (name, result, code, exit) in cases {
        let json = result.json();
        assert_eq!(json["error"], code, "{name}: {}", result.stdout);
        assert!(
            json["message"].as_str().is_some_and(|m| !m.is_empty()),
            "{name}"
        );
        assert_eq!(result.code, exit, "{name}");
    }
    let v6_result = raster(&v6, &jpeg, &v6_out);
    assert_eq!(v6_result.code, 0, "v 6 is supported: {}", v6_result.stdout);
    assert!(v6_out.is_file());
    let mut kept = vec![
        good.as_path(),
        wc_path.as_path(),
        meta_path.as_path(),
        not_an_image.as_path(),
    ];
    kept.extend([bad_meta.as_path(), as_file.as_path()]);
    kept.extend([
        no_v.as_path(),
        no_engine.as_path(),
        v6.as_path(),
        v6_out.as_path(),
        masks.as_path(),
        future_version.as_path(),
        crop.as_path(),
        crop_v1.as_path(),
        look.as_path(),
    ]);
    kept.extend([range.as_path(), types.as_path(), not_json.as_path()]);
    assert_eq!(
        dir.others(&kept),
        Vec::<String>::new(),
        "no output or partial file after a failure"
    );
}

#[test]
fn version_and_help() {
    let version = run(&["version"]);
    assert_eq!(version.code, 0);
    assert!(version.stdout.starts_with(&format!(
        "niho-develop-render {}",
        niho_develop::CRATE_VERSION
    )));
    assert!(version.stdout.contains("engine niho-14"));
    let help = run(&["--help"]);
    assert_eq!(help.code, 0);
    assert!(help.stdout.contains("Exit codes"));
}

#[test]
fn settings_loader_accepts_all_formula_versions_and_rejects_unknown() {
    for (engine, look) in [
        ("niho-1", "niho-interim-1"),
        ("niho-2", "niho-standard-1"),
        ("niho-3", "niho-standard-2"),
        ("niho-4", "niho-standard-3"),
        ("niho-5", "niho-standard-4"),
        ("niho-6", "niho-standard-1"),
        ("niho-7", "niho-standard-5"),
        ("niho-8", "niho-standard-1"),
        ("niho-10", "niho-standard-1"),
        ("niho-11", "niho-standard-5"),
        ("niho-12", "niho-standard-1"),
        ("niho-13", "niho-standard-1"),
        ("niho-14", "niho-standard-1"),
    ] {
        let settings = niho_develop_render::load_settings(&format!(
            r#"{{"v":1,"engine":"{engine}","look":"{look}"}}"#
        ))
        .unwrap();
        assert_eq!(settings.engine, engine);
    }
    let error = niho_develop_render::load_settings(
        r#"{"v":1,"engine":"niho-10","look":"niho-standard-5"}"#,
    )
    .unwrap_err();
    assert_eq!(error.code, niho_develop_render::ErrorCode::InvalidSettings);
    for engine in ["niho-12", "niho-13", "niho-14"] {
        let error = niho_develop_render::load_settings(&format!(
            r#"{{"v":1,"engine":"{engine}","look":"niho-standard-5"}}"#
        ))
        .unwrap_err();
        assert_eq!(error.code, niho_develop_render::ErrorCode::InvalidSettings);
    }
    let unsupported_engine =
        niho_develop_render::load_settings(r#"{"v":1,"engine":"niho-9","look":"niho-standard-5"}"#)
            .unwrap_err();
    assert_eq!(
        unsupported_engine.code,
        niho_develop_render::ErrorCode::UnsupportedSettings
    );
    assert!(unsupported_engine
        .message
        .contains("niho-1 through niho-8 and niho-10 through niho-14"));
    let missing_engine = niho_develop_render::load_settings(r#"{"v":1}"#).unwrap_err();
    assert!(missing_engine
        .message
        .contains("niho-1 through niho-8 and niho-10 through niho-14"));
}
