//! 背景除去（NIHO photo だけ。C4 #18392）: sidecar `niho-camera-cutout`（`packages/develop-engine/tools/niho-camera-cutout`。
//! README「機械が読む契約」）の版の照合・`detect`・`compose` と、レシピ・マスクの置き場。camera のコマンドから呼び、編集面の
//! 背景除去の口（`packages/photo-editing` の `PhotoEditingCutoutHost`）の中身になる。Tauri に依存しない。
//!
//! camera だけの機能なので `packages/desktop-photo` には置かない（あの crate の `src/` は NIHO Desktop の出荷対象で、変えると
//! Desktop の版上げが要る）。sidecar の実行（`run_sidecar`：HOME と PATH だけ・cwd `/`・プロセスグループ・時間切れで止める）と
//! 版の行の読み方はあの crate の公開の関数を使う。
//!
//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//!   （レシピ。`CutoutRecipe` をそのまま。ブラシの点で補正のファイルの上限 64KiB を超えうるので補正とは別のファイル）と
//!   `cutout-masks/<マスクの SHA-256>.png`（`detect` が置く不変のマスク）。フォルダは 0700、レシピは 0600 で一時ファイル＋rename。
//! - レシピは、写真の中身の SHA-256 が `detection.inputSHA256` と同じときだけ返す（写真が変わったら古いマスクを当てない）。
//! - マスクの名前は `<64 桁の小文字の 16 進>.png` だけを受け、読んだ中身の SHA-256 を名前と照らす（フォルダの外を指させない・
//!   壊れたマスクを当てない）。
//! - 掃除: レシピを保存したとき（24 時間に 1 回まで）、どのレシピも参照していないマスクのうち最終更新から 1 日を過ぎたものを消す
//!   （推論の直後で、まだ保存していないマスクは消さない）。
//! - 失敗は sidecar の `error`（`no_subjects` など）をそのまま [`PageError`] の `code` にする（編集面がその語彙で 1 行を選ぶ）。
//!   sidecar が答えない・時間切れは `engine_failed`。
//! - 部分補正の被写体のマスクの面（niho-photo#135）: `surface` で作業画像から面の PNG を作る（[`PhotoCutout::surface_cancellable`]。
//!   置き場は `mask_detection.rs` が写真の `MaskSurfaceStore` へ入れる）。

use niho_desktop_photo::common::{lock, random_hex, PageError};
use niho_desktop_photo::develop::{parse_version_line, run_sidecar, ToolRun};
use niho_desktop_photo::saved_settings::{ensure_private_dir, hex_lower, is_content_key};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// 同梱する sidecar の名前（`.app` の `Contents/MacOS/niho-camera-cutout`）。
pub const CUTOUT_SIDECAR_NAME: &str = "niho-camera-cutout";
pub const RECIPES_DIR_NAME: &str = "cutout";
pub const MASKS_DIR_NAME: &str = "cutout-masks";
/// レシピの上限（ブラシの点が増えても、ふつうの編集では届かない大きさ）。超えるレシピは保存しない・読まない。
pub const MAX_RECIPE_BYTES: usize = 4 * 1024 * 1024;
/// マスクの上限（6000×4000 の 8bit グレーの PNG は数 MiB）。
pub const MAX_MASK_BYTES: u64 = 64 * 1024 * 1024;
/// 参照されていないマスクを消すまでの猶予（推論の直後・保存の前のマスクを消さない）。
pub const ORPHAN_MASK_GRACE: Duration = Duration::from_secs(24 * 60 * 60);
const SWEEP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// sidecar の失敗の語彙（README の表）のうち、編集面へ渡すもの。ほかは `internal_error`。
pub const CUTOUT_ERROR_CODES: [&str; 17] = [
  "invalid_arguments",
  "unsupported_output",
  "invalid_strokes",
  "unknown_subject",
  "internal_error",
  "no_subjects",
  "engine_failed",
  "input_unreadable",
  "invalid_image",
  "corrupt_mask",
  "mask_mismatch",
  "destination_exists",
  "destination_is_directory",
  "source_overwrite",
  "encode_failed",
  "write_failed",
  "unsupported_kind",
];

#[derive(Debug, Clone)]
pub struct CutoutTimeouts {
  pub probe: Duration,
  /// 推論（6000×4000 で数秒。初回はモデルの読み込みで長い）
  pub detect: Duration,
  /// 原寸の合成と書き出し
  pub compose: Duration,
  pub kill_grace: Duration,
}

impl Default for CutoutTimeouts {
  fn default() -> Self {
    Self {
      probe: Duration::from_secs(20),
      detect: Duration::from_secs(120),
      compose: Duration::from_secs(120),
      kill_grace: Duration::from_secs(2),
    }
  }
}

#[derive(Debug, Clone)]
pub struct CutoutConfig {
  /// 同梱の sidecar
  pub sidecar: PathBuf,
  /// lock の版（`packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs entry` の `version`）。合わなければ閉じる
  pub expected_version: String,
  /// レシピとマスクを置くフォルダ（アプリのデータの下。例 `<Application Support>/life.niho.camera/photo-editing`）
  pub data_dir: PathBuf,
  pub timeouts: CutoutTimeouts,
}

/// `compose` の頼み（パスはアプリが決める。背景とブラシは編集面の `cutoutBackgroundArgument` / `cutoutStrokesJson` の値）。
#[derive(Debug, Clone)]
pub struct ComposeRequest {
  /// 現像した画像（原寸の PNG など）
  pub input: PathBuf,
  pub mask: String,
  pub background: String,
  pub strokes_json: String,
  /// `.png` か `.jpg`（拡張子で形式が決まる）。既にあれば sidecar が断る
  pub output: PathBuf,
  pub jpeg_quality: Option<f64>,
}

pub struct PhotoCutout {
  config: CutoutConfig,
  running: Mutex<Option<i32>>,
  last_sweep: Mutex<Option<Instant>>,
  /// 推論直後（レシピの保存より先）にもマスクを読めるよう、写真の SHA-256 ごとに最後の detect の答えを覚える。
  /// パスは持たない。保存済みレシピを読むときと同じく写真の SHA-256 を境界にする。
  recent_detections: Mutex<HashMap<String, Value>>,
}

fn page_error(code: &str) -> PageError {
  let code = if CUTOUT_ERROR_CODES.contains(&code) {
    code
  } else {
    "internal_error"
  };
  PageError::new(code, code)
}

/// `<path>.tmp-<乱数>` に 0600 で書いてから `path` へ rename する（途中で落ちても前の内容か新しい内容のどちらか）。
fn write_private_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
  use std::io::Write;
  use std::os::unix::fs::OpenOptionsExt;
  let temp = path.with_extension(format!("tmp-{}", random_hex(4)));
  let written = fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .mode(0o600)
    .open(&temp)
    .and_then(|mut file| file.write_all(contents).and_then(|()| file.sync_all()))
    .and_then(|()| fs::rename(&temp, path));
  if written.is_err() {
    let _ = fs::remove_file(&temp);
  }
  written
}

fn sha256_hex(bytes: &[u8]) -> String {
  hex_lower(&Sha256::digest(bytes))
}

fn kill_process_group(pid: i32) {
  #[cfg(unix)]
  unsafe {
    libc::killpg(pid as libc::pid_t, libc::SIGKILL);
  }
}

/// `run_sidecar` の PID 登録より先に取消が来ても、その取消を保持して登録直後のプロセスグループを止める。
/// watcher は実行終了前に必ず join するので、後続 operation の PID を止めない。
pub fn run_sidecar_cancellable(
  program: &Path,
  args: &[OsString],
  timeout: Duration,
  kill_grace: Duration,
  running: &Mutex<Option<i32>>,
  cancelled: &AtomicBool,
) -> ToolRun {
  let finished = AtomicBool::new(false);
  std::thread::scope(|scope| {
    let watcher = scope.spawn(|| {
      while !finished.load(Ordering::Acquire) {
        if cancelled.load(Ordering::Acquire) {
          if let Some(pid) = *lock(running) {
            kill_process_group(pid);
          }
        }
        std::thread::sleep(CANCEL_POLL_INTERVAL);
      }
    });
    let run = run_sidecar(program, args, timeout, kill_grace, running);
    finished.store(true, Ordering::Release);
    watcher.join().expect("cutout cancellation watcher panicked");
    run
  })
}

/// `<64 桁の小文字の 16 進>.png` のマスクの名前の SHA-256 の部分（ほかの名前は None）。
pub fn mask_digest(name: &str) -> Option<&str> {
  let digest = name.strip_suffix(".png")?;
  is_content_key(digest).then_some(digest)
}

/// sidecar が mask write の途中で止まったときの `.<sha>.partial-<pid>` だけを対象にする。
fn partial_mask_digest(name: &str) -> Option<&str> {
  let partial = name.strip_prefix('.')?;
  let (digest, pid) = partial.split_once(".partial-")?;
  (is_content_key(digest) && !pid.is_empty() && pid.bytes().all(|byte| byte.is_ascii_digit())).then_some(digest)
}

/// レシピが参照するマスクの名前（`detection.subjects[].mask`）。
fn referenced_masks(recipe: &Value) -> Vec<String> {
  recipe.get("detection").map(detection_masks).unwrap_or_default()
}

/// `detect` の答えのマスクの名前（`subjects[].mask`）。
fn detection_masks(detection: &Value) -> Vec<String> {
  detection
    .get("subjects")
    .and_then(Value::as_array)
    .map(|subjects| {
      subjects
        .iter()
        .filter_map(|subject| subject.get("mask").and_then(Value::as_str))
        .filter(|name| mask_digest(name).is_some())
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default()
}

impl PhotoCutout {
  pub fn new(config: CutoutConfig) -> Self {
    Self {
      config,
      running: Mutex::new(None),
      last_sweep: Mutex::new(None),
      recent_detections: Mutex::new(HashMap::new()),
    }
  }

  fn recipes_dir(&self) -> PathBuf {
    self.config.data_dir.join(RECIPES_DIR_NAME)
  }

  pub fn masks_dir(&self) -> PathBuf {
    self.config.data_dir.join(MASKS_DIR_NAME)
  }

  /// 走っている sidecar のプロセスグループ（アプリの終了・取り消しで止める）。
  pub fn running(&self) -> &Mutex<Option<i32>> {
    &self.running
  }

  /// 走っている推論・合成をプロセスグループごと止める。`run_sidecar` が子を回収し、`running` を空にする。
  pub fn cancel(&self) {
    let Some(pid) = *lock(&self.running) else { return };
    kill_process_group(pid);
  }

  /// 同梱の sidecar が lock の版に答えるか（起動時に 1 回。合わなければ背景除去を閉じる。spec 決まりごと 3）。答えた版を返す。
  pub fn probe(&self) -> Result<String, String> {
    let timeouts = &self.config.timeouts;
    let run = run_sidecar(
      &self.config.sidecar,
      &[OsString::from("version")],
      timeouts.probe,
      timeouts.kill_grace,
      &self.running,
    );
    if !run.succeeded() {
      return Err(format!("{CUTOUT_SIDECAR_NAME} version に答えません"));
    }
    let version = parse_version_line(CUTOUT_SIDECAR_NAME, &run.stdout)
      .ok_or_else(|| format!("{CUTOUT_SIDECAR_NAME} の版の行を読めません"))?;
    if version != self.config.expected_version {
      return Err(format!(
        "{CUTOUT_SIDECAR_NAME} の版が違います（同梱 {version} / lock {}）",
        self.config.expected_version
      ));
    }
    Ok(version)
  }

  /// `detect`: 推論して、被写体ごとのマスクを置き場に置き、`detect` の 1 行（`durationMs` を除く）を返す。
  #[cfg(test)]
  pub fn detect(&self, input: &Path) -> Result<Value, PageError> {
    self.detect_cancellable(input, &AtomicBool::new(false))
  }

  pub fn detect_cancellable(&self, input: &Path, cancelled: &AtomicBool) -> Result<Value, PageError> {
    let masks = self.masks_dir();
    ensure_private_dir(&self.config.data_dir).map_err(|_| page_error("write_failed"))?;
    ensure_private_dir(&masks).map_err(|_| page_error("write_failed"))?;
    let args = vec![
      OsString::from("detect"),
      OsString::from("--input"),
      input.as_os_str().to_os_string(),
      OsString::from("--masks-dir"),
      masks.as_os_str().to_os_string(),
    ];
    let timeouts = &self.config.timeouts;
    let run = run_sidecar_cancellable(
      &self.config.sidecar,
      &args,
      timeouts.detect,
      timeouts.kill_grace,
      &self.running,
      cancelled,
    );
    if !run.succeeded() {
      return Err(page_error(
        &run.tool_error().unwrap_or_else(|| "engine_failed".to_string()),
      ));
    }
    let last = run
      .stdout
      .lines()
      .map(str::trim)
      .rfind(|line| !line.is_empty())
      .unwrap_or("");
    let mut detection: Value = serde_json::from_str(last).map_err(|_| page_error("internal_error"))?;
    let object = detection.as_object_mut().ok_or_else(|| page_error("internal_error"))?;
    object.remove("durationMs");
    // 置いたと言ったマスクが本当にある（読めない答えは渡さない）
    for name in detection_masks(&detection) {
      if !masks.join(&name).is_file() {
        return Err(page_error("internal_error"));
      }
    }
    if let Some(key) = detection
      .get("inputSHA256")
      .and_then(Value::as_str)
      .filter(|key| is_content_key(key))
    {
      let mut recent = lock(&self.recent_detections);
      // 開いた写真の上限より十分小さく保つ。保存済みレシピはディスクから読めるので、古い推論を忘れてよい。
      if recent.len() >= 256 && !recent.contains_key(key) {
        recent.clear();
      }
      recent.insert(key.to_string(), detection.clone());
    }
    Ok(detection)
  }

  /// `subject` がこの写真の保存済みレシピ、または保存直前の最後の推論に含まれるか。名前だけでなく参照全体を照らす。
  pub fn subject_belongs_to_photo(&self, key: &str, subject: &Value) -> bool {
    if !is_content_key(key) || !subject.is_object() {
      return false;
    }
    let contains = |detection: &Value| {
      detection
        .get("subjects")
        .and_then(Value::as_array)
        .is_some_and(|subjects| subjects.iter().any(|candidate| candidate == subject))
    };
    self
      .load_recipe(key)
      .and_then(|recipe| recipe.get("detection").cloned())
      .is_some_and(|detection| contains(&detection))
      || lock(&self.recent_detections).get(key).is_some_and(contains)
  }

  /// 写真に属することを照合してからマスクを読む。
  pub fn read_mask_for_photo(&self, key: &str, subject: &Value) -> Result<Vec<u8>, PageError> {
    if !self.subject_belongs_to_photo(key, subject) {
      return Err(page_error("corrupt_mask"));
    }
    let name = subject
      .get("mask")
      .and_then(Value::as_str)
      .ok_or_else(|| page_error("corrupt_mask"))?;
    self.read_mask(name)
  }

  /// 置き場のマスクを読む（名前の形と中身の SHA-256 を照らす）。
  pub fn read_mask(&self, name: &str) -> Result<Vec<u8>, PageError> {
    let digest = mask_digest(name).ok_or_else(|| page_error("corrupt_mask"))?;
    let path = self.masks_dir().join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|_| page_error("corrupt_mask"))?;
    if !metadata.is_file() || metadata.len() > MAX_MASK_BYTES {
      return Err(page_error("corrupt_mask"));
    }
    let bytes = fs::read(&path).map_err(|_| page_error("corrupt_mask"))?;
    if sha256_hex(&bytes) != digest {
      return Err(page_error("corrupt_mask"));
    }
    Ok(bytes)
  }

  /// `surface`: 作業画像（`input`）の全部の被写体を 1 枚の面の PNG にして `output`（まだ無いファイル）に書き、`surface` の 1 行
  /// （`durationMs` を除く）と書いた PNG を返す。PNG の SHA-256 が答えの `surfaceSHA256` と違えば `internal_error`。
  pub fn surface_cancellable(
    &self,
    input: &Path,
    kind: &str,
    output: &Path,
    cancelled: &AtomicBool,
  ) -> Result<(Value, Vec<u8>), PageError> {
    let args = vec![
      OsString::from("surface"),
      OsString::from("--input"),
      input.as_os_str().to_os_string(),
      OsString::from("--output"),
      output.as_os_str().to_os_string(),
      OsString::from("--kind"),
      OsString::from(kind),
    ];
    let timeouts = &self.config.timeouts;
    let run = run_sidecar_cancellable(
      &self.config.sidecar,
      &args,
      timeouts.detect,
      timeouts.kill_grace,
      &self.running,
      cancelled,
    );
    if !run.succeeded() {
      return Err(page_error(
        &run.tool_error().unwrap_or_else(|| "engine_failed".to_string()),
      ));
    }
    let last = run
      .stdout
      .lines()
      .map(str::trim)
      .rfind(|line| !line.is_empty())
      .unwrap_or("");
    let mut summary: Value = serde_json::from_str(last).map_err(|_| page_error("internal_error"))?;
    let object = summary.as_object_mut().ok_or_else(|| page_error("internal_error"))?;
    object.remove("durationMs");
    let written = fs::read(output).map_err(|_| page_error("internal_error"))?;
    if summary.get("surfaceSHA256").and_then(Value::as_str) != Some(sha256_hex(&written).as_str()) {
      return Err(page_error("internal_error"));
    }
    Ok((summary, written))
  }

  /// `compose`: 現像した画像にマスク・ブラシ・背景を当てて書き出し、`compose` の 1 行を返す。ブラシの JSON は一時ファイルに書いて渡す。
  #[cfg(test)]
  pub fn compose(&self, request: &ComposeRequest) -> Result<Value, PageError> {
    self.compose_cancellable(request, &AtomicBool::new(false))
  }

  pub fn compose_cancellable(&self, request: &ComposeRequest, cancelled: &AtomicBool) -> Result<Value, PageError> {
    let digest = mask_digest(&request.mask)
      .ok_or_else(|| page_error("corrupt_mask"))?
      .to_string();
    let mask = self.masks_dir().join(&request.mask);
    ensure_private_dir(&self.config.data_dir).map_err(|_| page_error("write_failed"))?;
    let strokes = self
      .config
      .data_dir
      .join(format!(".cutout-strokes-{}.json", random_hex(8)));
    write_private_atomically(&strokes, request.strokes_json.as_bytes()).map_err(|_| page_error("write_failed"))?;
    let mut args = vec![
      OsString::from("compose"),
      OsString::from("--input"),
      request.input.as_os_str().to_os_string(),
      OsString::from("--mask"),
      mask.as_os_str().to_os_string(),
      OsString::from("--mask-sha256"),
      OsString::from(digest),
      OsString::from("--background"),
      OsString::from(&request.background),
      OsString::from("--strokes"),
      strokes.as_os_str().to_os_string(),
      OsString::from("--output"),
      request.output.as_os_str().to_os_string(),
    ];
    if let Some(quality) = request.jpeg_quality {
      args.push(OsString::from("--jpeg-quality"));
      args.push(OsString::from(format!("{}", quality.clamp(0.0, 1.0))));
    }
    let timeouts = &self.config.timeouts;
    let run = run_sidecar_cancellable(
      &self.config.sidecar,
      &args,
      timeouts.compose,
      timeouts.kill_grace,
      &self.running,
      cancelled,
    );
    let _ = fs::remove_file(&strokes);
    if !run.succeeded() {
      return Err(page_error(
        &run.tool_error().unwrap_or_else(|| "engine_failed".to_string()),
      ));
    }
    let last = run
      .stdout
      .lines()
      .map(str::trim)
      .rfind(|line| !line.is_empty())
      .unwrap_or("");
    let mut summary: Value = serde_json::from_str(last).map_err(|_| page_error("internal_error"))?;
    // パスは返さない（ページはアプリが決めた書き出し先を知っている）
    if let Some(object) = summary.as_object_mut() {
      object.remove("output");
    }
    Ok(summary)
  }

  /// 写真（中身の SHA-256 = `key`）の保存したレシピ。無い・壊れた・大きすぎる・別の写真の推論のレシピは None。
  pub fn load_recipe(&self, key: &str) -> Option<Value> {
    if !is_content_key(key) {
      return None;
    }
    let path = self.recipes_dir().join(format!("{key}.json"));
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_RECIPE_BYTES as u64 {
      return None;
    }
    let recipe: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
    (recipe.pointer("/detection/inputSHA256").and_then(Value::as_str) == Some(key)).then_some(recipe)
  }

  /// レシピを保存する（None は外す）。別の写真の推論のレシピ・大きすぎるレシピは `invalidRequest` 相当で断る。
  pub fn save_recipe(&self, key: &str, recipe: Option<&Value>, now: SystemTime) -> io::Result<()> {
    if !is_content_key(key) {
      return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid key"));
    }
    let dir = self.recipes_dir();
    let path = dir.join(format!("{key}.json"));
    match recipe {
      None => match fs::remove_file(&path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
        _ => {}
      },
      Some(recipe) => {
        if recipe.pointer("/detection/inputSHA256").and_then(Value::as_str) != Some(key) {
          return Err(io::Error::new(io::ErrorKind::InvalidInput, "recipe for another photo"));
        }
        let bytes = serde_json::to_vec(recipe).map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
        if bytes.len() > MAX_RECIPE_BYTES {
          return Err(io::Error::new(io::ErrorKind::InvalidInput, "recipe too large"));
        }
        ensure_private_dir(&self.config.data_dir)?;
        ensure_private_dir(&dir)?;
        write_private_atomically(&path, &bytes)?;
      }
    }
    self.sweep_if_due(now);
    Ok(())
  }

  fn sweep_if_due(&self, now: SystemTime) {
    {
      let mut last = lock(&self.last_sweep);
      if last.is_some_and(|at| at.elapsed() < SWEEP_INTERVAL) {
        return;
      }
      *last = Some(Instant::now());
    }
    let _ = self.sweep_orphan_masks(now);
  }

  /// 古い未参照マスクと、[`ORPHAN_MASK_GRACE`] を過ぎた中断 partial mask を消す。消した数を返す。
  pub fn sweep_orphan_masks(&self, now: SystemTime) -> io::Result<usize> {
    let mut referenced = HashSet::new();
    if let Ok(entries) = fs::read_dir(self.recipes_dir()) {
      for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(key) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
          continue;
        };
        if let Some(recipe) = self.load_recipe(key) {
          referenced.extend(referenced_masks(&recipe));
        }
      }
    }
    let mut removed = 0;
    let entries = match fs::read_dir(self.masks_dir()) {
      Ok(entries) => entries,
      Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(0),
      Err(err) => return Err(err),
    };
    for entry in entries.flatten() {
      let name = entry.file_name();
      let Some(name) = name.to_str() else { continue };
      let final_mask = mask_digest(name).is_some();
      let partial_mask = partial_mask_digest(name).is_some();
      if (!final_mask && !partial_mask) || (final_mask && referenced.contains(name)) {
        continue;
      }
      // active writer には触れない。detect の上限（120 秒）より十分長い 24 時間を猶予し、symlink も対象外にする。
      let Ok(file_type) = entry.file_type() else { continue };
      if !file_type.is_file() {
        continue;
      }
      let Ok(metadata) = entry.metadata() else { continue };
      let old = metadata
        .modified()
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_some_and(|age| age >= ORPHAN_MASK_GRACE);
      if old && fs::remove_file(entry.path()).is_ok() {
        removed += 1;
      }
    }
    Ok(removed)
  }
}

#[cfg(test)]
#[path = "cutout_tests.rs"]
mod tests;
