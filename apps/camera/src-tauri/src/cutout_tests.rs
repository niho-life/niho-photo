use super::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

/// ファイルの更新日時を変える（古いマスクを作る）。
fn set_modified(path: &Path, when: SystemTime) {
  fs::File::options()
    .write(true)
    .open(path)
    .unwrap()
    .set_modified(when)
    .unwrap();
}

/// 偽の `niho-camera-cutout`（sh）。引数・環境変数・cwd を書き残し、印のファイルで失敗・待ちを作る。
const FAKE_CUTOUT: &str = r#"#!/bin/sh
d=$(dirname "$0")
cmd="$1"; shift
{ printf '%s' "$cmd"; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'; } >> "$d/calls.txt"
env | sort > "$d/env.txt"
pwd > "$d/cwd.txt"
case "$cmd" in
  version)
    [ -f "$d/version-exit" ] && exit 1
    if [ -f "$d/version" ]; then echo "niho-camera-cutout $(cat "$d/version")"; else echo "niho-camera-cutout 0.2.0"; fi ;;
  detect)
    masks=""
    while [ $# -gt 0 ]; do case "$1" in --masks-dir) masks="$2"; shift 2 ;; *) shift ;; esac; done
    [ -f "$d/hang" ] && sleep 30
    [ -f "$d/detect-error" ] && { printf '{"error":"%s","message":"/test-data/users/secret/P1.JPG"}\n' "$(cat "$d/detect-error")"; exit 2; }
    [ -f "$d/skip-mask" ] || cp "$d/mask.png" "$masks/$(cat "$d/mask-sha").png"
    cat "$d/detect.json" ;;
  compose)
    strokes=""; out=""
    while [ $# -gt 0 ]; do
      case "$1" in --strokes) strokes="$2"; shift 2 ;; --output) out="$2"; shift 2 ;; *) shift ;; esac
    done
    cp "$strokes" "$d/strokes-seen.json"
    [ -f "$d/compose-error" ] && { printf '{"error":"%s","message":"x"}\n' "$(cat "$d/compose-error")"; exit 3; }
    printf 'PNG' > "$out"
    printf '{"durationMs":5,"format":"png","height":2,"output":"%s","strokes":1,"width":4}\n' "$out" ;;
  surface)
    out=""; kind=""
    while [ $# -gt 0 ]; do
      case "$1" in --output) out="$2"; shift 2 ;; --kind) kind="$2"; shift 2 ;; *) shift ;; esac
    done
    [ -f "$d/surface-error" ] && { printf '{"error":"%s","message":"x"}\n' "$(cat "$d/surface-error")"; exit 2; }
    cp "$d/surface.png" "$out"
    printf '{"bytes":19,"durationMs":7,"height":2,"kind":"%s","subjects":1,"surfaceSHA256":"%s","width":4}\n' "$kind" "$(cat "$d/surface-sha")" ;;
esac
"#;

const MASK: &[u8] = b"\x89PNG fake mask";

struct Fixture {
  root: PathBuf,
  bin: PathBuf,
  cutout: PhotoCutout,
  mask_sha: String,
  photo_sha: String,
}

impl Fixture {
  fn new(name: &str) -> Self {
    let root = std::env::temp_dir().join(format!("niho-cutout-{name}-{}", random_hex(6)));
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let sidecar = bin.join(CUTOUT_SIDECAR_NAME);
    fs::write(&sidecar, FAKE_CUTOUT).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o755)).unwrap();
    let mask_sha = sha256_hex(MASK);
    let photo_sha = "a".repeat(64);
    fs::write(bin.join("mask.png"), MASK).unwrap();
    fs::write(bin.join("mask-sha"), &mask_sha).unwrap();
    fs::write(
      bin.join("detect.json"),
      detection(&photo_sha, &mask_sha).to_string() + "\n",
    )
    .unwrap();
    let cutout = PhotoCutout::new(CutoutConfig {
      sidecar,
      expected_version: "0.2.0".to_string(),
      data_dir: root.join("data"),
      timeouts: CutoutTimeouts {
        probe: Duration::from_secs(5),
        detect: Duration::from_secs(5),
        compose: Duration::from_secs(5),
        kill_grace: Duration::from_millis(200),
      },
    });
    Self {
      root,
      bin,
      cutout,
      mask_sha,
      photo_sha,
    }
  }

  fn mark(&self, name: &str, content: &str) {
    fs::write(self.bin.join(name), content).unwrap();
  }

  fn read(&self, name: &str) -> String {
    fs::read_to_string(self.bin.join(name)).unwrap_or_default()
  }
}

impl Drop for Fixture {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.root);
  }
}

fn detection(photo_sha: &str, mask_sha: &str) -> Value {
  json!({
    "schemaVersion": 1, "engine": "VNGenerateForegroundInstanceMaskRequest", "engineRevision": 1,
    "width": 4, "height": 2, "inputSHA256": photo_sha, "sourceOrientation": 1, "largest": "instance-1",
    "subjects": [
      {"selection": "instance-1", "pixelCount": 6, "mask": format!("{mask_sha}.png"), "maskSHA256": mask_sha, "maskWidth": 4, "maskHeight": 2},
      {"selection": "all", "pixelCount": 6, "mask": format!("{mask_sha}.png"), "maskSHA256": mask_sha, "maskWidth": 4, "maskHeight": 2}
    ],
    "durationMs": 1141
  })
}

fn recipe(photo_sha: &str, mask_sha: &str) -> Value {
  let mut detection = detection(photo_sha, mask_sha);
  detection.as_object_mut().unwrap().remove("durationMs");
  json!({"v": 1, "detection": detection, "selected": "instance-1", "background": {"kind": "transparent"}, "strokes": []})
}

#[test]
fn probe_checks_the_version_line_against_the_lock() {
  let fixture = Fixture::new("probe");
  assert_eq!(fixture.cutout.probe().unwrap(), "0.2.0");
  fixture.mark("version", "0.1.0");
  assert!(fixture.cutout.probe().unwrap_err().contains("0.1.0"));
  fixture.mark("version-exit", "");
  assert!(fixture.cutout.probe().is_err());
}

#[test]
fn detect_runs_in_the_sidecar_environment_and_returns_the_line_without_duration() {
  let fixture = Fixture::new("detect");
  let input = fixture.root.join("P1.JPG");
  fs::write(&input, b"jpeg").unwrap();
  let detection = fixture.cutout.detect(&input).unwrap();
  assert_eq!(detection["inputSHA256"], json!(fixture.photo_sha));
  assert!(detection.get("durationMs").is_none());
  let masks = fixture.cutout.masks_dir();
  assert_eq!(
    fixture.read("calls.txt").trim(),
    format!("detect --input {} --masks-dir {}", input.display(), masks.display())
  );
  // HOME と PATH だけ・cwd は /（ほかの sidecar と同じ）
  let env = fixture.read("env.txt");
  assert!(env.lines().any(|line| line == "PATH=/usr/bin:/bin"));
  assert!(!env
    .lines()
    .any(|line| line.starts_with("CARGO") || line.starts_with("RUST")));
  assert_eq!(fixture.read("cwd.txt").trim(), "/");
  // 置き場のフォルダは本人だけ
  assert_eq!(fs::metadata(&masks).unwrap().permissions().mode() & 0o777, 0o700);
  assert_eq!(
    fixture.cutout.read_mask(&format!("{}.png", fixture.mask_sha)).unwrap(),
    MASK
  );
}

#[test]
fn detect_failures_keep_the_sidecar_vocabulary() {
  let fixture = Fixture::new("detect-fail");
  let input = fixture.root.join("P1.JPG");
  fs::write(&input, b"jpeg").unwrap();
  fixture.mark("detect-error", "no_subjects");
  assert_eq!(fixture.cutout.detect(&input).unwrap_err().code, "no_subjects");
  // 知らない語は internal_error（ページが知らない code を渡さない）
  fixture.mark("detect-error", "something_new");
  assert_eq!(fixture.cutout.detect(&input).unwrap_err().code, "internal_error");
  fs::remove_file(fixture.bin.join("detect-error")).unwrap();
  // 置いたと言ったマスクが無い答えは渡さない
  fixture.mark("skip-mask", "");
  assert_eq!(fixture.cutout.detect(&input).unwrap_err().code, "internal_error");
}

#[test]
fn a_hanging_detect_is_stopped_and_reported_as_engine_failed() {
  let mut fixture = Fixture::new("detect-hang");
  fixture.cutout.config.timeouts.detect = Duration::from_millis(300);
  let input = fixture.root.join("P1.JPG");
  fs::write(&input, b"jpeg").unwrap();
  fixture.mark("hang", "");
  let started = Instant::now();
  assert_eq!(fixture.cutout.detect(&input).unwrap_err().code, "engine_failed");
  assert!(started.elapsed() < Duration::from_secs(5));
  assert!(lock(fixture.cutout.running()).is_none());
}

#[test]
fn cancel_stops_the_running_detect_process_group() {
  let fixture = Fixture::new("detect-cancel");
  let input = fixture.root.join("P1.JPG");
  fs::write(&input, b"jpeg").unwrap();
  fixture.mark("hang", "");
  let cutout = Arc::new(PhotoCutout::new(fixture.cutout.config.clone()));
  let worker = {
    let cutout = cutout.clone();
    std::thread::spawn(move || cutout.detect(&input))
  };
  let deadline = Instant::now() + Duration::from_secs(3);
  while lock(cutout.running()).is_none() && Instant::now() < deadline {
    std::thread::sleep(Duration::from_millis(10));
  }
  assert!(lock(cutout.running()).is_some(), "偽 sidecar が起動しなかった");
  cutout.cancel();
  assert_eq!(worker.join().unwrap().unwrap_err().code, "engine_failed");
  assert!(lock(cutout.running()).is_none());
}

#[test]
fn cancellation_before_pid_registration_stops_that_run_but_not_the_next_one() {
  let fixture = Fixture::new("detect-cancel-before-start");
  let input = fixture.root.join("P1.JPG");
  fs::write(&input, b"jpeg").unwrap();
  fixture.mark("hang", "");
  let cancelled = AtomicBool::new(true);
  let started = Instant::now();
  assert_eq!(
    fixture.cutout.detect_cancellable(&input, &cancelled).unwrap_err().code,
    "engine_failed"
  );
  assert!(started.elapsed() < Duration::from_secs(5));
  assert!(lock(fixture.cutout.running()).is_none());

  // 前の watcher は run の終了前に join 済みなので、新しい operation の PID を止めない。
  fs::remove_file(fixture.bin.join("hang")).unwrap();
  let next = AtomicBool::new(false);
  assert_eq!(
    fixture.cutout.detect_cancellable(&input, &next).unwrap()["inputSHA256"],
    json!(fixture.photo_sha)
  );
}

#[test]
fn read_mask_accepts_only_content_named_masks_in_the_folder() {
  let fixture = Fixture::new("mask");
  let masks = fixture.cutout.masks_dir();
  fs::create_dir_all(&masks).unwrap();
  let name = format!("{}.png", fixture.mask_sha);
  fs::write(masks.join(&name), MASK).unwrap();
  assert_eq!(fixture.cutout.read_mask(&name).unwrap(), MASK);
  for bad in [
    "../secret.png",
    "mask.png",
    &format!("{}.PNG", fixture.mask_sha),
    &format!("{}.png", fixture.mask_sha.to_uppercase()),
  ] {
    assert_eq!(fixture.cutout.read_mask(bad).unwrap_err().code, "corrupt_mask", "{bad}");
  }
  // 中身が名前の SHA-256 と違う（壊れた・置き換えられた）
  let other = format!("{}.png", "b".repeat(64));
  fs::write(masks.join(&other), MASK).unwrap();
  assert_eq!(fixture.cutout.read_mask(&other).unwrap_err().code, "corrupt_mask");
  // シンボリックリンクはたどらない
  let link = format!("{}.png", sha256_hex(b"elsewhere"));
  std::os::unix::fs::symlink(masks.join(&name), masks.join(&link)).unwrap();
  assert_eq!(fixture.cutout.read_mask(&link).unwrap_err().code, "corrupt_mask");
}

#[test]
fn compose_passes_the_mask_digest_and_strokes_and_hides_the_output_path() {
  let fixture = Fixture::new("compose");
  let request = ComposeRequest {
    input: fixture.root.join("developed.png"),
    mask: format!("{}.png", fixture.mask_sha),
    background: "#336699".to_string(),
    strokes_json: r#"[{"mode":"erase","radius":0.1,"points":[{"x":0.5,"y":0.5}]}]"#.to_string(),
    output: fixture.root.join("out.png"),
    jpeg_quality: Some(0.9),
  };
  let summary = fixture.cutout.compose(&request).unwrap();
  assert_eq!(summary["width"], json!(4));
  assert!(summary.get("output").is_none());
  let call = fixture.read("calls.txt");
  let mask = fixture.cutout.masks_dir().join(&request.mask);
  assert!(
    call.contains(&format!("--mask {} --mask-sha256 {}", mask.display(), fixture.mask_sha)),
    "{call}"
  );
  assert!(call.contains("--background #336699"));
  assert!(call.contains("--jpeg-quality 0.9"));
  assert_eq!(fixture.read("strokes-seen.json"), request.strokes_json);
  // ブラシの一時ファイルは残さない
  let leftovers: Vec<_> = fs::read_dir(fixture.root.join("data"))
    .unwrap()
    .flatten()
    .filter(|entry| entry.file_name().to_string_lossy().starts_with(".cutout-strokes-"))
    .collect();
  assert!(leftovers.is_empty());

  fixture.mark("compose-error", "mask_mismatch");
  assert_eq!(fixture.cutout.compose(&request).unwrap_err().code, "mask_mismatch");
  let bad = ComposeRequest {
    mask: "../x.png".to_string(),
    ..request
  };
  assert_eq!(fixture.cutout.compose(&bad).unwrap_err().code, "corrupt_mask");
}

#[test]
fn recipes_round_trip_only_for_the_photo_they_were_detected_on() {
  let fixture = Fixture::new("recipe");
  let key = fixture.photo_sha.clone();
  let value = recipe(&key, &fixture.mask_sha);
  assert!(fixture.cutout.load_recipe(&key).is_none());
  fixture
    .cutout
    .save_recipe(&key, Some(&value), SystemTime::now())
    .unwrap();
  assert_eq!(fixture.cutout.load_recipe(&key), Some(value.clone()));
  let path = fixture
    .root
    .join("data")
    .join(RECIPES_DIR_NAME)
    .join(format!("{key}.json"));
  assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
  // 別の写真の推論のレシピは保存しない・読まない（写真が変わったら古いマスクを当てない）
  let other = "c".repeat(64);
  assert!(fixture
    .cutout
    .save_recipe(&other, Some(&value), SystemTime::now())
    .is_err());
  fs::copy(&path, path.with_file_name(format!("{other}.json"))).unwrap();
  assert!(fixture.cutout.load_recipe(&other).is_none());
  // 鍵の形でないもの・大きすぎるもの
  assert!(fixture
    .cutout
    .save_recipe("../x", Some(&value), SystemTime::now())
    .is_err());
  let mut huge = value.clone();
  huge["strokes"] =
    json!([{"mode": "erase", "radius": 0.1, "points": vec![json!({"x": 0.123456789, "y": 0.987654321}); 200_000]}]);
  assert!(fixture
    .cutout
    .save_recipe(&key, Some(&huge), SystemTime::now())
    .is_err());
  assert_eq!(fixture.cutout.load_recipe(&key), Some(value));
  // None は外す（無くても失敗にしない）
  fixture.cutout.save_recipe(&key, None, SystemTime::now()).unwrap();
  assert!(fixture.cutout.load_recipe(&key).is_none());
  fixture.cutout.save_recipe(&key, None, SystemTime::now()).unwrap();
}

#[test]
fn masks_are_read_only_for_a_subject_from_that_photo() {
  let fixture = Fixture::new("mask-owner");
  let input = fixture.root.join("P1.JPG");
  fs::write(&input, b"jpeg").unwrap();
  let detection = fixture.cutout.detect(&input).unwrap();
  let subject = &detection["subjects"][0];
  assert!(fixture.cutout.subject_belongs_to_photo(&fixture.photo_sha, subject));
  assert_eq!(
    fixture.cutout.read_mask_for_photo(&fixture.photo_sha, subject).unwrap(),
    MASK
  );
  assert_eq!(
    fixture
      .cutout
      .read_mask_for_photo(&"b".repeat(64), subject)
      .unwrap_err()
      .code,
    "corrupt_mask"
  );
  let forged = json!({"selection": "instance-1", "mask": format!("{}.png", fixture.mask_sha)});
  assert_eq!(
    fixture
      .cutout
      .read_mask_for_photo(&fixture.photo_sha, &forged)
      .unwrap_err()
      .code,
    "corrupt_mask"
  );
}

#[test]
fn sweep_removes_only_old_unreferenced_masks() {
  let fixture = Fixture::new("sweep");
  let masks = fixture.cutout.masks_dir();
  fs::create_dir_all(&masks).unwrap();
  let referenced = format!("{}.png", fixture.mask_sha);
  let orphan_old = format!("{}.png", "d".repeat(64));
  let orphan_young = format!("{}.png", "e".repeat(64));
  let partial_old = format!(".{}.partial-123", "f".repeat(64));
  let partial_young = format!(".{}.partial-456", "a".repeat(64));
  for name in [
    &referenced,
    &orphan_old,
    &orphan_young,
    &partial_old,
    &partial_young,
    &".partial-x".to_string(),
    &"notes.txt".to_string(),
  ] {
    fs::write(masks.join(name), b"x").unwrap();
  }
  let now = SystemTime::now();
  let long_ago = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
  for name in [
    &referenced,
    &orphan_old,
    &partial_old,
    &".partial-x".to_string(),
    &"notes.txt".to_string(),
  ] {
    set_modified(&masks.join(name), long_ago);
  }
  fixture
    .cutout
    .save_recipe(
      &fixture.photo_sha,
      Some(&recipe(&fixture.photo_sha, &fixture.mask_sha)),
      now,
    )
    .unwrap();
  assert!(masks.join(&referenced).exists());
  assert!(!masks.join(&orphan_old).exists());
  assert!(masks.join(&orphan_young).exists());
  assert!(!masks.join(&partial_old).exists());
  assert!(masks.join(&partial_young).exists());
  assert!(masks.join(".partial-x").exists() && masks.join("notes.txt").exists());
  // 24 時間に 1 回まで（すぐ後の保存では掃除しない）
  fs::write(masks.join(&orphan_old), b"x").unwrap();
  set_modified(&masks.join(&orphan_old), long_ago);
  fs::write(masks.join(&partial_old), b"x").unwrap();
  set_modified(&masks.join(&partial_old), long_ago);
  fixture
    .cutout
    .save_recipe(
      &fixture.photo_sha,
      Some(&recipe(&fixture.photo_sha, &fixture.mask_sha)),
      now,
    )
    .unwrap();
  assert!(masks.join(&orphan_old).exists() && masks.join(&partial_old).exists());
  assert_eq!(fixture.cutout.sweep_orphan_masks(now).unwrap(), 2);
}

#[test]
fn surface_writes_the_png_and_returns_it_with_the_line_without_duration() {
  let fixture = Fixture::new("surface");
  let input = fixture.root.join("working.png");
  fs::write(&input, b"png").unwrap();
  let png = b"\x89PNG fake surface".to_vec();
  fs::write(fixture.bin.join("surface.png"), &png).unwrap();
  fixture.mark("surface-sha", &sha256_hex(&png));
  let output = fixture.root.join("surface.png");
  let (summary, bytes) = fixture
    .cutout
    .surface_cancellable(&input, "subject", &output, &AtomicBool::new(false))
    .unwrap();
  assert_eq!(bytes, png);
  assert_eq!(summary["kind"], json!("subject"));
  assert_eq!(summary["surfaceSHA256"], json!(sha256_hex(&png)));
  assert!(summary.get("durationMs").is_none());
  assert_eq!(
    fixture.read("calls.txt").trim(),
    format!(
      "surface --input {} --output {} --kind subject",
      input.display(),
      output.display()
    )
  );
  assert_eq!(fixture.read("cwd.txt").trim(), "/");
}

#[test]
fn surface_failures_keep_the_sidecar_vocabulary() {
  let fixture = Fixture::new("surface-fail");
  let input = fixture.root.join("working.png");
  fs::write(&input, b"png").unwrap();
  let output = fixture.root.join("surface.png");
  let run = |output: &Path| {
    fixture
      .cutout
      .surface_cancellable(&input, "subject", output, &AtomicBool::new(false))
      .unwrap_err()
      .code
  };
  for code in ["no_subjects", "unsupported_kind", "engine_failed"] {
    fixture.mark("surface-error", code);
    assert_eq!(run(&output), code);
  }
  fixture.mark("surface-error", "something_new");
  assert_eq!(run(&output), "internal_error");
  fs::remove_file(fixture.bin.join("surface-error")).unwrap();
  // 答えの SHA-256 が書いた PNG と違えば渡さない
  fixture.mark("surface.png", "PNG");
  fixture.mark("surface-sha", &"0".repeat(64));
  assert_eq!(run(&fixture.root.join("other.png")), "internal_error");
}
