//! 部分補正の被写体のマスクの面を、この Mac で作る（niho-photo#135。docs/local-adjustments.md「面の受け渡し」「検出」）。
//!
//! `camera_mask_surface_detect`（`{ photoId, kind, operationId, developSettings }` → `{ id, width, height }`）は、開いた写真の
//! **作業画像**（マスクの座標の基準）に同梱の `niho-camera-cutout surface` を当て、できた面を写真の `MaskSurfaceStore` へ保存する。
//!
//! - 作業画像: JPEG / PNG / HEIC / TIFF は元の写真（sidecar が向きを当てる。ラスタの作業コピーは同じ枠を縮めただけなので、元で
//!   検出した面と端は変わらない）。RAW は編集中の作業コピー（`camera_develop_source` と同じ context で選ぶ。レンズ補正を焼き
//!   込んでいるので、元の RAW で検出すると端がずれる）を、同梱の `niho-develop-render` で sRGB 8bit にする。描く設定は画面の
//!   設定の `engine`・`look` と作業コピーの `base` だけ（その作業コピーを描ける数式。補正・幾何・レンズ・マスクは当てない）。
//! - 同じ写真（中身の SHA-256）・同じ作業画像（RAW は `baseVersion`、ほかは元の写真）・同じ種類の面が置き場に残っていれば、
//!   検出せずにそれを返す（アプリを閉じるまで覚える）。
//! - 背景除去と同じ sidecar・同じ同時 1 本の枠を使い、取り消しは `camera_cutout_cancel`（`operationId`）。途中のファイルはアプリの
//!   キャッシュの一時フォルダに置き、成功・失敗にかかわらず消す。
//! - 失敗の code: sidecar の語（`no_subjects`＝被写体が無い・`unsupported_kind`＝まだ作れない種類（`sky`）・`engine_failed` など）、
//!   `aborted`（取り消した）、現像の code（RAW の作業コピー）、面の置き場の code（`maskSurfaceQuota` など）、`invalidRequest`。

use crate::cutout_commands::{check_operation_id, cutout, page_failure, require_available, verified_photo, CUTOUT_FAILED_MESSAGE};
use crate::develop::{bundled_sidecar_paths, develop, stored_source_context};
use crate::error::{invalid_request, parse_request, run_blocking, CameraError};
use crate::photos::{check_photo_id, photos};
use niho_desktop_photo::common::{lock, new_opaque_id};
use niho_desktop_photo::develop::DevelopSourceContext;
use niho_desktop_photo::library::photo_kind;
use niho_desktop_photo::saved_settings::ensure_private_dir;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::Manager;

/// 作れる種類（`sky` は口だけ。sidecar が `unsupported_kind` で断る）。
pub const MASK_DETECTION_KINDS: [&str; 2] = ["subject", "sky"];
/// RAW の作業コピーを描く長辺の上限（面の上限と同じ。作業コピーは 2560 なので縮めない）。
const WORKING_IMAGE_MAX_DIMENSION: u32 = 4096;
/// 作業コピーを sRGB 8bit にする時間の上限。
const WORKING_IMAGE_TIMEOUT: Duration = Duration::from_secs(120);
const KILL_GRACE: Duration = Duration::from_secs(2);
/// 覚える検出の数（超えたら忘れる。置き場の面は残る）。
const MAX_REMEMBERED: usize = 256;
/// 画面から受ける設定の大きさの上限（補正の保存と同じ）。
const MAX_SETTINGS_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetectSurfaceRequest {
  pub photo_id: String,
  pub kind: String,
  pub operation_id: String,
  /// 画面がいま描いている補正（RAW の作業画像を描く `engine`・`look`・`base` を読む）
  pub develop_settings: Value,
}

/// 同じ写真・同じ作業画像・同じ種類の検出の答え（`{ id, width, height }`）。
#[derive(Default)]
pub struct MaskDetections(Mutex<HashMap<String, Value>>);

pub struct MaskDetectionState(pub Arc<MaskDetections>);

impl MaskDetections {
  fn get(&self, key: &str) -> Option<Value> {
    lock(&self.0).get(key).cloned()
  }

  fn remember(&self, key: String, surface: Value) {
    let mut remembered = lock(&self.0);
    if remembered.len() >= MAX_REMEMBERED && !remembered.contains_key(&key) {
      remembered.clear();
    }
    remembered.insert(key, surface);
  }
}

pub fn install(app: &tauri::AppHandle) {
  app.manage(MaskDetectionState(Arc::new(MaskDetections::default())));
}

/// 検出の答えを覚える key（写真の中身・種類・作業画像）。
pub fn detection_key(photo_key: &str, kind: &str, working_image: &str) -> String {
  format!("{photo_key}/{kind}/{working_image}")
}

pub fn validate_request(request: &DetectSurfaceRequest) -> Result<(), CameraError> {
  check_photo_id(&request.photo_id)?;
  check_operation_id(&request.operation_id)?;
  if !MASK_DETECTION_KINDS.contains(&request.kind.as_str()) {
    return Err(invalid_request());
  }
  let small = serde_json::to_vec(&request.develop_settings).is_ok_and(|bytes| bytes.len() <= MAX_SETTINGS_BYTES);
  if !request.develop_settings.is_object() || !small {
    return Err(invalid_request());
  }
  Ok(())
}

/// RAW の作業コピーを sRGB 8bit に描く設定: 画面の設定の数式（`engine`・`look`）と作業コピーの `base` だけ。補正・幾何・
/// レンズ・マスクは当てない（面は作業画像の枠で作る）。
pub fn working_image_settings(develop_settings: &Value, base_version: &str) -> Result<Value, CameraError> {
  let engine = develop_settings
    .get("engine")
    .and_then(Value::as_str)
    .ok_or_else(invalid_request)?;
  let mut settings = json!({ "v": 1, "engine": engine, "base": base_version });
  if let Some(look) = develop_settings.get("look").and_then(Value::as_str) {
    settings["look"] = json!(look);
  }
  Ok(settings)
}

/// 途中のファイルの一時フォルダ（消すのは drop）。
struct WorkDir(PathBuf);

impl WorkDir {
  fn create(root: &Path) -> io::Result<Self> {
    ensure_private_dir(root)?;
    let path = root.join(new_opaque_id("detect"));
    ensure_private_dir(&path)?;
    Ok(Self(path))
  }
}

impl Drop for WorkDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn aborted() -> CameraError {
  CameraError::new("aborted", CUTOUT_FAILED_MESSAGE)
}

/// 開いた写真の作業画像の面を作って保存する（`{ id, width, height }`）。
#[tauri::command]
pub async fn camera_mask_surface_detect(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: DetectSurfaceRequest = parse_request(request)?;
  validate_request(&request)?;
  let photos = photos(&app)?;
  let develop = develop(&app)?;
  let cutout = cutout(&app)?;
  require_available(&cutout, false)?;
  let detections = app
    .try_state::<MaskDetectionState>()
    .map(|state| state.0.clone())
    .ok_or_else(crate::error::internal)?;
  let work_root = app
    .path()
    .app_cache_dir()
    .map_err(|_| crate::error::internal())?
    .join("mask-detect");
  let operation = cutout.begin(request.operation_id.clone())?;
  run_blocking(move || {
    let photo = verified_photo(&photos, &request.photo_id)?;
    let raw = photo_kind(&photo.file_name) == Some("raw");
    // RAW の作業コピー（編集中と同じ context で選ぶ。キャッシュにあれば作らない）
    let source = if raw {
      let context = stored_source_context(&photos, &request.photo_id).or_else(|| {
        request
          .develop_settings
          .get("base")
          .and_then(Value::as_str)
          .map(|base| DevelopSourceContext {
            has_saved_develop_settings: false,
            has_develop_edits: true,
            base_version: Some(base.to_string()),
          })
      });
      let source = develop.source_with_options_context(photos.as_ref(), &request.photo_id, context, false)?;
      if source.get("kind").and_then(Value::as_str) != Some("workingCopy") {
        return Err(page_failure("internal_error", false));
      }
      Some(source)
    } else {
      None
    };
    let working_image = match &source {
      Some(source) => source
        .get("baseVersion")
        .and_then(Value::as_str)
        .ok_or_else(|| page_failure("internal_error", false))?
        .to_string(),
      None => "original".to_string(),
    };
    let key = detection_key(&photo.digest.key, &request.kind, &working_image);
    if let Some(surface) = detections.get(&key) {
      let id = surface.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
      if photos.missing_mask_surfaces(&request.photo_id, &[id])?.is_empty() {
        return Ok(surface);
      }
    }
    if operation.cancelled() {
      return Err(aborted());
    }

    let work = WorkDir::create(&work_root).map_err(|_| page_failure("write_failed", false))?;
    let input = match &source {
      None => photo.path.clone(),
      Some(source) => {
        let token = source
          .get("token")
          .and_then(Value::as_str)
          .ok_or_else(|| page_failure("internal_error", false))?;
        let bytes = develop.source_bytes(photos.as_ref(), &request.photo_id, token)?;
        let working_copy = work.0.join("working-copy.png");
        let meta = work.0.join("working-copy.meta.json");
        let settings = work.0.join("settings.json");
        let rendered = work.0.join("working-image.png");
        // 一時フォルダは 0700 で、この操作だけが使う
        let write = |path: &Path, bytes: &[u8]| fs::write(path, bytes).map_err(|_| page_failure("write_failed", false));
        write(&working_copy, &bytes)?;
        drop(bytes);
        write(
          &meta,
          &serde_json::to_vec(source.get("meta").unwrap_or(&Value::Null)).map_err(|_| invalid_request())?,
        )?;
        write(
          &settings,
          &serde_json::to_vec(&working_image_settings(&request.develop_settings, &working_image)?)
            .map_err(|_| invalid_request())?,
        )?;
        let renderer = bundled_sidecar_paths()
          .map(|paths| paths.develop_render)
          .ok_or_else(|| page_failure("engine_failed", false))?;
        let run = crate::cutout::run_sidecar_cancellable(
          &renderer,
          &[
            OsString::from("render"),
            OsString::from("--settings"),
            settings.into_os_string(),
            OsString::from("--out"),
            rendered.clone().into_os_string(),
            OsString::from("--max-dimension"),
            OsString::from(WORKING_IMAGE_MAX_DIMENSION.to_string()),
            OsString::from("--working-copy"),
            working_copy.into_os_string(),
            OsString::from("--meta"),
            meta.into_os_string(),
            OsString::from("--base-version"),
            OsString::from(&working_image),
          ],
          WORKING_IMAGE_TIMEOUT,
          KILL_GRACE,
          cutout.engine().running(),
          operation.cancellation(),
        );
        if operation.cancelled() {
          return Err(aborted());
        }
        if !run.succeeded() {
          return Err(page_failure("engine_failed", false));
        }
        rendered
      }
    };

    let output = work.0.join("surface.png");
    let (_, png) = match cutout
      .engine()
      .surface_cancellable(&input, &request.kind, &output, operation.cancellation())
    {
      Ok(done) => done,
      Err(_) if operation.cancelled() => return Err(aborted()),
      Err(error) => return Err(CameraError::from(error)),
    };
    if operation.cancelled() {
      return Err(aborted());
    }
    // 検出の間に写真が置き換わっていれば、その写真の面として保存しない
    let current = verified_photo(&photos, &request.photo_id)?;
    if current.digest != photo.digest {
      return Err(page_failure("internal_error", false));
    }
    let info = photos.save_mask_surface(&request.photo_id, &png, SystemTime::now())?;
    let surface = json!({ "id": info.id, "width": info.width, "height": info.height });
    detections.remember(key, surface.clone());
    Ok(surface)
  })
  .await
}

#[cfg(test)]
#[path = "mask_detection_tests.rs"]
mod tests;
