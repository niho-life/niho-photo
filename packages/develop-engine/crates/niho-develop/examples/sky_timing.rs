//! The sky model natively (niho-photo#141, `docs/local-adjustments.md`
//! "空の検出"): how long 「空」 takes, and whether the Rust inference gives
//! what `train_sky.py predict` gives. The model is a private run of #158
//! (`<run>/layout.json` and `<run>/weights.f32`); nothing of it is in the
//! repo.
//!
//! `cargo run --release -p niho-develop --example sky_timing -- --model <run> [--photo <JPEG/PNG>] [--trials 5]`
//!
//! One JSON line. For each trial a new Developer opens the photo (at most
//! 2560 on the long side, as the editor's working copy) and renders its
//! editor frame (Final 1280), untimed; then `press` is the first
//! `Developer.detect_sky` (the working image at 1024, the model, the PNG)
//! and `again` a second one on the same Developer. `model` is
//! `sky::predict` alone on the working image, `load` the model's
//! `set_sky_model`. Medians and every run in milliseconds. Without
//! `--photo` the photo is a synthetic 3:2 one of 2560 x 1707 (the time
//! does not depend on what the photo shows, only on its shape).
//!
//! `cargo run --release -p niho-develop --example sky_timing -- --model <run> --parity <inputs> <predictions>`
//!
//! For every `<inputs>/<id>.png` with a `<predictions>/<id>.png`
//! (`train_sky.py predict` of the same run on the same photo): one JSON
//! line with the mean and largest absolute difference of the two 0..=255
//! maps and the IoU of their sky (128 and up), then a summary line.

use std::path::{Path, PathBuf};
use std::time::Instant;

use niho_develop::api::{self, Developer};
use niho_develop::sky::{self, SkyModel};
use serde_json::json;

const SETTINGS: &str = r#"{"v":1,"engine":"niho-14","look":"niho-standard-1","base":null}"#;
const EDITOR: &str = r#"{"v":1,"engine":"niho-14","look":"niho-standard-1","base":null,"exposure":0.3,"contrast":10,"shadows":20}"#;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn read_model(run: &Path) -> (String, Vec<u8>) {
    let layout = std::fs::read_to_string(run.join("layout.json")).expect("layout.json");
    let weights = std::fs::read(run.join("weights.f32")).expect("weights.f32");
    (layout, weights)
}

fn synthetic_photo() -> Vec<u8> {
    let (w, h) = (2560usize, 1707usize);
    let rgba: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            let (x, y) = (i % w, i / w);
            if y < h * 2 / 5 {
                [110, 160, (235 - y / 8) as u8, 255]
            } else {
                let n = ((x * 7 + y * 13) % 50) as u8;
                [90 + n, 80 + n / 2, 50, 255]
            }
        })
        .collect();
    niho_develop::encode::encode_png(&rgba, w, h).unwrap()
}

fn ms(start: Instant) -> f64 {
    (start.elapsed().as_secs_f64() * 1e4).round() / 10.0
}

fn median(values: &[f64]) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

fn timing(run: &Path, photo: Option<PathBuf>, trials: usize) {
    let bytes = photo
        .map(|p| std::fs::read(p).expect("photo"))
        .unwrap_or_else(synthetic_photo);
    let (layout, weights) = read_model(run);
    let start = Instant::now();
    let described = api::set_sky_model(&layout, &weights).expect("model");
    let load = ms(start);
    let (mut press, mut again, mut model_only) = (Vec::new(), Vec::new(), Vec::new());
    let mut size = (0, 0);
    let mut sky_share = 0.0;
    for _ in 0..trials {
        let mut developer = Developer::new(&bytes, 2560).expect("photo");
        developer.render(EDITOR, 1280, false).expect("editor frame");
        let start = Instant::now();
        let found = developer.detect_sky(SETTINGS, None).expect("detectSky");
        press.push(ms(start));
        let start = Instant::now();
        developer.detect_sky(SETTINGS, None).expect("detectSky");
        again.push(ms(start));
        if let Some(found) = found {
            size = (found.width, found.height);
        }
        let frame = developer
            .render(SETTINGS, 1024, false)
            .expect("working image");
        let rgb: Vec<u8> = frame
            .rgba
            .chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();
        let model: SkyModel = SkyModel::parse(&layout, &weights).unwrap();
        let start = Instant::now();
        let surface = sky::predict(&model, &rgb, frame.width, frame.height, None).unwrap();
        model_only.push(ms(start));
        sky_share =
            surface.data.iter().filter(|&&v| v >= 128).count() as f64 / surface.data.len() as f64;
    }
    println!(
        "{}",
        json!({
            "model": serde_json::from_str::<serde_json::Value>(&described).unwrap(),
            "threads": api::thread_count(),
            "surface": format!("{}x{}", size.0, size.1),
            "skyShare": (sky_share * 1000.0).round() / 1000.0,
            "loadMs": load,
            "pressMs": median(&press), "againMs": median(&again), "modelMs": median(&model_only),
            "press": press, "again": again, "modelOnly": model_only,
        })
    );
}

fn read_rgb(path: &Path) -> (Vec<u8>, usize, usize) {
    let image = image::open(path).expect("PNG").to_rgb8();
    let (w, h) = (image.width() as usize, image.height() as usize);
    (image.into_raw(), w, h)
}

fn parity(run: &Path, inputs: &Path, predictions: &Path) {
    let (layout, weights) = read_model(run);
    let model = SkyModel::parse(&layout, &weights).expect("model");
    let mut names: Vec<PathBuf> = std::fs::read_dir(inputs)
        .expect("inputs")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "png"))
        .collect();
    names.sort();
    let (mut count, mut mean_sum, mut largest, mut iou_min) = (0usize, 0.0f64, 0u8, 1.0f64);
    for input in names {
        let reference = predictions.join(input.file_name().unwrap());
        if !reference.exists() {
            continue;
        }
        let (rgb, w, h) = read_rgb(&input);
        let ours = sky::predict(&model, &rgb, w, h, None).unwrap();
        let theirs = image::open(&reference).expect("prediction").to_luma8();
        assert_eq!((theirs.width() as usize, theirs.height() as usize), (w, h));
        let theirs = theirs.into_raw();
        let diff: Vec<u8> = ours
            .data
            .iter()
            .zip(&theirs)
            .map(|(a, b)| a.abs_diff(*b))
            .collect();
        let mean = diff.iter().map(|&d| d as f64).sum::<f64>() / diff.len() as f64;
        let max = diff.iter().copied().max().unwrap_or(0);
        let (mut both, mut either) = (0usize, 0usize);
        for (a, b) in ours.data.iter().zip(&theirs) {
            let (a, b) = (*a >= 128, *b >= 128);
            both += (a && b) as usize;
            either += (a || b) as usize;
        }
        let iou = if either == 0 {
            1.0
        } else {
            both as f64 / either as f64
        };
        let id = input.file_stem().unwrap().to_string_lossy().to_string();
        println!(
            "{}",
            json!({"id": id, "size": format!("{w}x{h}"), "meanAbs": (mean * 1000.0).round() / 1000.0,
                   "maxAbs": max, "skyIoU": (iou * 10000.0).round() / 10000.0})
        );
        count += 1;
        mean_sum += mean;
        largest = largest.max(max);
        iou_min = iou_min.min(iou);
    }
    println!(
        "{}",
        json!({"photos": count, "meanAbs": (mean_sum / count.max(1) as f64 * 1000.0).round() / 1000.0,
               "maxAbs": largest, "skyIoUMin": (iou_min * 10000.0).round() / 10000.0})
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let run = PathBuf::from(arg(&args, "--model").expect("--model <run dir>"));
    if let Some(i) = args.iter().position(|a| a == "--parity") {
        parity(&run, Path::new(&args[i + 1]), Path::new(&args[i + 2]));
        return;
    }
    let trials = arg(&args, "--trials").map_or(5, |t| t.parse().expect("--trials"));
    timing(&run, arg(&args, "--photo").map(PathBuf::from), trials);
}
