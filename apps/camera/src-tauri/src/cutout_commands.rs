//! NIHO photo の背景除去を、共通編集面の `PhotoEditingCutoutHost` へつなぐ Tauri commands。
//!
//! 画面から受ける写真の識別子は開いた `photoId` だけで、パスは受けない・返さない。毎回 `CameraPhotos::verified` で中身の
//! SHA-256 を読み直してから `cutout.rs` へ渡す。レシピとマスクはその SHA-256 に属するものだけを扱う。

use crate::cutout::{
  run_sidecar_cancellable, ComposeRequest, CutoutConfig, CutoutTimeouts, PhotoCutout, CUTOUT_ERROR_CODES,
  CUTOUT_SIDECAR_NAME,
};
use crate::develop::{bundled_sidecar_paths, develop};
use crate::error::{invalid_request, parse_request, run_blocking, CameraError};
use crate::photos::{check_photo_id, photos, CameraPhotos, OpenedPhoto};
use crate::{dialog, save};
use niho_desktop_photo::common::{code, lock, new_opaque_id};
use niho_desktop_photo::develop::Overwrite;
use niho_desktop_photo::saved_settings::ensure_private_dir;
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;
use tauri::Manager;

pub(crate) const CUTOUT_FAILED_MESSAGE: &str = "背景除去を使えませんでした。もう一度お試しください。";
const CUTOUT_EXPORT_FAILED_MESSAGE: &str = "背景除去を反映した写真を書き出せませんでした。";
const ORIGINAL_OVERWRITE_MESSAGE: &str = "元の写真には上書きできません。別の名前で保存してください。";
const MAX_OPERATION_ID_BYTES: usize = 128;

#[derive(Debug)]
struct RunningOperation {
  id: String,
  cancelled: Arc<AtomicBool>,
}

/// probe の結果と、sidecar を同時に 2 本走らせないための状態。
pub struct CameraCutout {
  engine: PhotoCutout,
  configured: bool,
  available: OnceLock<bool>,
  operation: Mutex<Option<RunningOperation>>,
}

impl CameraCutout {
  fn new(engine: PhotoCutout, configured: bool) -> Self {
    Self {
      engine,
      configured,
      available: OnceLock::new(),
      operation: Mutex::new(None),
    }
  }

  pub(crate) fn probe(&self) -> bool {
    *self
      .available
      .get_or_init(|| self.configured && self.engine.probe().is_ok())
  }

  /// 同梱の sidecar の本体（被写体のマスクの面の検出 `mask_detection.rs` も使う）。
  pub(crate) fn engine(&self) -> &PhotoCutout {
    &self.engine
  }

  /// sidecar を使う操作を 1 本だけ始める（背景除去と被写体のマスクの面の検出で共有。取り消しは `camera_cutout_cancel`）。
  pub(crate) fn begin(self: &Arc<Self>, id: String) -> Result<OperationGuard, CameraError> {
    let mut operation = lock(&self.operation);
    if operation.is_some() {
      return Err(CameraError::new("engine_failed", CUTOUT_FAILED_MESSAGE));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    *operation = Some(RunningOperation {
      id: id.clone(),
      cancelled: cancelled.clone(),
    });
    Ok(OperationGuard {
      owner: self.clone(),
      id,
      cancelled,
    })
  }

  fn cancel(&self, id: &str) {
    let operation = lock(&self.operation);
    let Some(operation) = operation.as_ref().filter(|operation| operation.id == id) else {
      return;
    };
    operation.cancelled.store(true, Ordering::SeqCst);
    // operation lock を持ったまま現在の PID を止める。古い guard の drop と次の begin はこの後なので、
    // ここで別 operation の PID を誤って止めることはない。まだ PID が無い場合は cancellation watcher が引き継ぐ。
    self.engine.cancel();
  }

  fn shutdown(&self) {
    let operation = lock(&self.operation);
    if let Some(operation) = operation.as_ref() {
      operation.cancelled.store(true, Ordering::SeqCst);
    }
    self.engine.cancel();
  }
}

pub(crate) struct OperationGuard {
  owner: Arc<CameraCutout>,
  id: String,
  cancelled: Arc<AtomicBool>,
}

impl OperationGuard {
  pub(crate) fn cancelled(&self) -> bool {
    self.cancelled.load(Ordering::SeqCst)
  }

  pub(crate) fn cancellation(&self) -> &AtomicBool {
    &self.cancelled
  }
}

impl Drop for OperationGuard {
  fn drop(&mut self) {
    let mut operation = lock(&self.owner.operation);
    if operation.as_ref().is_some_and(|operation| operation.id == self.id) {
      *operation = None;
    }
  }
}

pub struct CutoutState(pub Arc<CameraCutout>);

fn expected_version() -> Option<String> {
  let lock: Value = serde_json::from_str(include_str!("../../develop-sidecars.lock.json")).ok()?;
  lock.pointer("/nihoCameraCutout/version")?.as_str().map(str::to_string)
}

/// `.app/Contents/MacOS/niho-camera-cutout`。debug build だけ環境変数で受入用の実行ファイルへ差し替える。
pub fn bundled_cutout_path() -> Option<PathBuf> {
  let mut path = std::env::current_exe().ok()?.parent()?.join(CUTOUT_SIDECAR_NAME);
  #[cfg(debug_assertions)]
  if let Some(development) = std::env::var_os("NIHO_CAMERA_CUTOUT_PATH").filter(|value| !value.is_empty()) {
    path = PathBuf::from(development);
  }
  Some(path)
}

pub fn install(app: &tauri::AppHandle) {
  let sidecar = bundled_cutout_path();
  let expected_version = expected_version();
  let data_dir = app.path().app_data_dir().ok().map(|dir| dir.join("photo-editing"));
  let configured = sidecar.is_some() && expected_version.is_some() && data_dir.is_some();
  let engine = PhotoCutout::new(CutoutConfig {
    sidecar: sidecar.unwrap_or_default(),
    expected_version: expected_version.unwrap_or_default(),
    data_dir: data_dir.unwrap_or_default(),
    timeouts: CutoutTimeouts::default(),
  });
  let cutout = Arc::new(CameraCutout::new(engine, configured));
  app.manage(CutoutState(cutout.clone()));
  std::thread::spawn(move || {
    cutout.probe();
  });
}

pub(crate) fn cutout(app: &tauri::AppHandle) -> Result<Arc<CameraCutout>, CameraError> {
  app
    .try_state::<CutoutState>()
    .map(|state| state.0.clone())
    .ok_or_else(crate::error::internal)
}

pub fn shutdown(app: &tauri::AppHandle) {
  if let Some(state) = app.try_state::<CutoutState>() {
    state.0.shutdown();
  }
}

pub(crate) fn check_operation_id(id: &str) -> Result<(), CameraError> {
  if !id.is_empty()
    && id.len() <= MAX_OPERATION_ID_BYTES
    && id
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
  {
    Ok(())
  } else {
    Err(invalid_request())
  }
}

pub(crate) fn verified_photo(photos: &CameraPhotos, photo_id: &str) -> Result<OpenedPhoto, CameraError> {
  check_photo_id(photo_id)?;
  photos.verified(photo_id)
}

pub(crate) fn page_failure(code: &str, export: bool) -> CameraError {
  let code = if CUTOUT_ERROR_CODES.contains(&code) {
    code
  } else {
    "internal_error"
  };
  CameraError::new(
    code,
    if export {
      CUTOUT_EXPORT_FAILED_MESSAGE
    } else {
      CUTOUT_FAILED_MESSAGE
    },
  )
}

pub(crate) fn require_available(cutout: &CameraCutout, export: bool) -> Result<(), CameraError> {
  cutout
    .probe()
    .then_some(())
    .ok_or_else(|| page_failure("engine_failed", export))
}

fn recipe_for_photo<'a>(recipe: &'a Value, key: &str) -> Result<&'a serde_json::Map<String, Value>, CameraError> {
  let object = recipe.as_object().ok_or_else(invalid_request)?;
  if object.get("v").and_then(Value::as_u64) != Some(1)
    || recipe.pointer("/detection/inputSHA256").and_then(Value::as_str) != Some(key)
  {
    return Err(invalid_request());
  }
  Ok(object)
}

fn selected_subject(recipe: &Value) -> Result<&Value, CameraError> {
  let selected = recipe
    .get("selected")
    .and_then(Value::as_str)
    .ok_or_else(invalid_request)?;
  recipe
    .pointer("/detection/subjects")
    .and_then(Value::as_array)
    .and_then(|subjects| {
      subjects
        .iter()
        .find(|subject| subject.get("selection").and_then(Value::as_str) == Some(selected))
    })
    .ok_or_else(invalid_request)
}

fn background_argument(recipe: &Value, format: ExportFormat) -> Result<String, CameraError> {
  let background = recipe
    .get("background")
    .and_then(Value::as_object)
    .ok_or_else(invalid_request)?;
  let kind = background
    .get("kind")
    .and_then(Value::as_str)
    .ok_or_else(invalid_request)?;
  match kind {
    "transparent" if format == ExportFormat::Jpeg => Ok("white".to_string()),
    "transparent" | "white" => Ok(kind.to_string()),
    "color" => {
      let color = background
        .get("color")
        .and_then(Value::as_str)
        .ok_or_else(invalid_request)?;
      if color.len() == 7
        && color.starts_with('#')
        && color[1..]
          .bytes()
          .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
      {
        Ok(color.to_string())
      } else {
        Err(invalid_request())
      }
    }
    _ => Err(invalid_request()),
  }
}

/// 共通実装の `hasDevelopGeometry` と同じ恒等判定。壊れた形は安全側（geometry あり）に倒す。
pub fn has_develop_geometry(settings: &Value) -> bool {
  let Some(settings) = settings.as_object() else {
    return false;
  };
  let Some(geometry) = settings.get("geometry") else {
    return false;
  };
  if geometry.is_null() {
    return false;
  }
  let Some(geometry) = geometry.as_object() else {
    return true;
  };
  let integer = |name: &str, default| match geometry.get(name) {
    None => Some(default),
    Some(value) => value.as_i64(),
  };
  let boolean = |name: &str, default| match geometry.get(name) {
    None => Some(default),
    Some(value) => value.as_bool(),
  };
  let number = |object: &serde_json::Map<String, Value>, name: &str, default| match object.get(name) {
    None => Some(default),
    Some(value) => value.as_f64(),
  };
  let Some(rotate) = integer("rotate", 0) else {
    return true;
  };
  let Some(flip_h) = boolean("flipH", false) else {
    return true;
  };
  let Some(flip_v) = boolean("flipV", false) else {
    return true;
  };
  if !((rotate == 0 && !flip_h && !flip_v) || (rotate == 180 && flip_h && flip_v)) {
    return true;
  }
  let Some(angle) = number(geometry, "angle", 0.0) else {
    return true;
  };
  if angle != 0.0 {
    return true;
  }
  let crop = match geometry.get("crop") {
    None => return false,
    Some(value) => match value.as_object() {
      Some(crop) => crop,
      None => return true,
    },
  };
  number(crop, "left", 0.0) != Some(0.0)
    || number(crop, "top", 0.0) != Some(0.0)
    || number(crop, "right", 1.0) != Some(1.0)
    || number(crop, "bottom", 1.0) != Some(1.0)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
  Png,
  Jpeg,
}

impl ExportFormat {
  fn extension(self) -> &'static str {
    match self {
      Self::Png => "png",
      Self::Jpeg => "jpg",
    }
  }
}

fn export_file_name(original: &str, format: ExportFormat) -> String {
  let stem = Path::new(original)
    .file_stem()
    .map(|stem| stem.to_string_lossy().into_owned())
    .filter(|stem| !stem.is_empty())
    .unwrap_or_else(|| "photo".to_string());
  format!("{stem}.{}", format.extension())
}

struct ExportWork(PathBuf);

impl ExportWork {
  fn create(root: &Path) -> io::Result<Self> {
    ensure_private_dir(root)?;
    let path = root.join(format!("cutout-export-{}", new_opaque_id("work")));
    ensure_private_dir(&path)?;
    Ok(Self(path))
  }
}

impl Drop for ExportWork {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoRequest {
  pub photo_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRecipeRequest {
  pub photo_id: String,
  pub recipe: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetectRequest {
  pub photo_id: String,
  pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRequest {
  pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadMaskRequest {
  pub photo_id: String,
  pub subject: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequest {
  pub photo_id: String,
  pub recipe: Value,
  pub develop_settings: Value,
  pub format: ExportFormat,
}

#[tauri::command]
pub async fn camera_cutout_status(app: tauri::AppHandle) -> Result<Value, CameraError> {
  let cutout = cutout(&app)?;
  run_blocking(move || Ok(json!({ "available": cutout.probe() }))).await
}

#[tauri::command]
pub async fn camera_cutout_load_recipe(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: PhotoRequest = parse_request(request)?;
  let photos = photos(&app)?;
  let cutout = cutout(&app)?;
  require_available(&cutout, false)?;
  run_blocking(move || {
    let photo = verified_photo(&photos, &request.photo_id)?;
    Ok(json!({ "recipe": cutout.engine.load_recipe(&photo.digest.key) }))
  })
  .await
}

#[tauri::command]
pub async fn camera_cutout_save_recipe(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: SaveRecipeRequest = parse_request(request)?;
  let photos = photos(&app)?;
  let cutout = cutout(&app)?;
  require_available(&cutout, false)?;
  run_blocking(move || {
    let photo = verified_photo(&photos, &request.photo_id)?;
    let recipe = if request.recipe.is_null() {
      None
    } else {
      recipe_for_photo(&request.recipe, &photo.digest.key)?;
      Some(&request.recipe)
    };
    cutout
      .engine
      .save_recipe(&photo.digest.key, recipe, SystemTime::now())
      .map_err(|error| {
        if error.kind() == io::ErrorKind::InvalidInput {
          invalid_request()
        } else {
          page_failure("write_failed", false)
        }
      })?;
    Ok(json!({}))
  })
  .await
}

#[tauri::command]
pub async fn camera_cutout_detect(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: DetectRequest = parse_request(request)?;
  check_operation_id(&request.operation_id)?;
  let photos = photos(&app)?;
  let cutout = cutout(&app)?;
  require_available(&cutout, false)?;
  let operation = cutout.begin(request.operation_id)?;
  run_blocking(move || {
    let photo = verified_photo(&photos, &request.photo_id)?;
    if operation.cancelled() {
      return Err(CameraError::new("aborted", CUTOUT_FAILED_MESSAGE));
    }
    let detection = match cutout.engine.detect_cancellable(&photo.path, operation.cancellation()) {
      Ok(detection) => detection,
      Err(_) if operation.cancelled() => return Err(CameraError::new("aborted", CUTOUT_FAILED_MESSAGE)),
      Err(error) => return Err(CameraError::from(error)),
    };
    if operation.cancelled() {
      return Err(CameraError::new("aborted", CUTOUT_FAILED_MESSAGE));
    }
    let current = verified_photo(&photos, &request.photo_id)?;
    if current.digest != photo.digest || detection.get("inputSHA256").and_then(Value::as_str) != Some(&photo.digest.key)
    {
      return Err(page_failure("internal_error", false));
    }
    Ok(json!({ "detection": detection }))
  })
  .await
}

#[tauri::command]
pub async fn camera_cutout_cancel(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: CancelRequest = parse_request(request)?;
  check_operation_id(&request.operation_id)?;
  cutout(&app)?.cancel(&request.operation_id);
  Ok(json!({}))
}

#[tauri::command]
pub async fn camera_cutout_read_mask(
  app: tauri::AppHandle,
  request: Option<Value>,
) -> Result<tauri::ipc::Response, CameraError> {
  let request: ReadMaskRequest = parse_request(request)?;
  let photos = photos(&app)?;
  let cutout = cutout(&app)?;
  require_available(&cutout, false)?;
  let bytes = run_blocking(move || {
    let photo = verified_photo(&photos, &request.photo_id)?;
    let bytes = cutout
      .engine
      .read_mask_for_photo(&photo.digest.key, &request.subject)
      .map_err(CameraError::from)?;
    let current = verified_photo(&photos, &request.photo_id)?;
    if current.digest != photo.digest {
      return Err(page_failure("corrupt_mask", false));
    }
    Ok(bytes)
  })
  .await?;
  Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn camera_cutout_export(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: ExportRequest = parse_request(request)?;
  let settings_too_large = match serde_json::to_vec(&request.develop_settings) {
    Ok(bytes) => bytes.len() > 64 * 1024,
    Err(_) => true,
  };
  if !request.develop_settings.is_object() || settings_too_large || has_develop_geometry(&request.develop_settings) {
    return Err(invalid_request());
  }
  let photos = photos(&app)?;
  let develop = develop(&app)?;
  let cutout = cutout(&app)?;
  require_available(&cutout, true)?;
  let cache = app.path().app_cache_dir().map_err(|_| crate::error::internal())?;
  // 保存先を選ぶ前は、書き出し可否の確認だけをする。原寸の現像・合成はキャンセル時に始めない。
  let photo = {
    let (photos, develop, cutout, request) = (photos.clone(), develop.clone(), cutout.clone(), request.clone());
    run_blocking(move || {
      let photo = verified_photo(&photos, &request.photo_id)?;
      recipe_for_photo(&request.recipe, &photo.digest.key)?;
      let subject = selected_subject(&request.recipe)?;
      if !cutout.engine.subject_belongs_to_photo(&photo.digest.key, subject) {
        return Err(page_failure("corrupt_mask", true));
      }
      develop
        .check_export(photos.as_ref(), &request.photo_id)
        .map_err(CameraError::from)?;
      Ok(photo)
    })
    .await?
  };
  let format = request.format;
  let file_name = export_file_name(&photo.file_name, format);
  let filter: (&str, &[&str]) = match format {
    ExportFormat::Png => ("PNG", &["png"]),
    ExportFormat::Jpeg => ("JPEG", &["jpg", "jpeg"]),
  };
  let Some(destination) = dialog::save_file("書き出す", &file_name, filter).await? else {
    return Ok(json!({ "saved": false, "fileName": file_name }));
  };
  let destination = save::with_extension_of_kind(destination, filter.1, format.extension());
  if photos.is_open_original(&destination) {
    return Err(CameraError::new(code::EXPORT_FAILED, ORIGINAL_OVERWRITE_MESSAGE));
  }
  let saved_name = destination
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| file_name.clone());
  let expected_digest = photo.digest.clone();
  let operation = cutout.begin(new_opaque_id("compose"))?;
  let (work, ready) = run_blocking(move || {
    let photo = verified_photo(&photos, &request.photo_id)?;
    if photo.digest != expected_digest {
      return Err(page_failure("internal_error", true));
    }
    recipe_for_photo(&request.recipe, &photo.digest.key)?;
    let subject = selected_subject(&request.recipe)?;
    if !cutout.engine.subject_belongs_to_photo(&photo.digest.key, subject) {
      return Err(page_failure("corrupt_mask", true));
    }
    let mask = subject
      .get("mask")
      .and_then(Value::as_str)
      .ok_or_else(invalid_request)?;
    let background = background_argument(&request.recipe, format)?;
    let strokes = serde_json::to_string(request.recipe.get("strokes").ok_or_else(invalid_request)?)
      .map_err(|_| invalid_request())?;
    let work = ExportWork::create(&cache.join("cutout-export")).map_err(|_| page_failure("write_failed", true))?;
    let developed = work.0.join("developed.jpg");
    develop
      .export(
        photos.as_ref(),
        &request.photo_id,
        &request.develop_settings,
        &developed,
        Overwrite::Never,
      )
      .map_err(CameraError::from)?;
    let composed = work.0.join("composed.png");
    cutout
      .engine
      .compose_cancellable(
        &ComposeRequest {
          input: developed,
          mask: mask.to_string(),
          background,
          strokes_json: strokes,
          output: composed.clone(),
          jpeg_quality: None,
        },
        operation.cancellation(),
      )
      .map_err(CameraError::from)?;
    let ready = match format {
      ExportFormat::Png => composed,
      ExportFormat::Jpeg => {
        let output = work.0.join("composed.jpg");
        let apple = bundled_sidecar_paths()
          .map(|paths| paths.apple_raw_linear)
          .ok_or_else(|| page_failure("engine_failed", true))?;
        let run = run_sidecar_cancellable(
          &apple,
          &[
            OsString::from("encode-jpeg"),
            OsString::from("--pixels"),
            composed.as_os_str().to_os_string(),
            OsString::from("--metadata-from"),
            photo.path.as_os_str().to_os_string(),
            OsString::from("--out"),
            output.as_os_str().to_os_string(),
            OsString::from("--quality"),
            OsString::from("0.92"),
          ],
          CutoutTimeouts::default().compose,
          CutoutTimeouts::default().kill_grace,
          cutout.engine.running(),
          operation.cancellation(),
        );
        if !run.succeeded() {
          return Err(page_failure(
            run.tool_error().as_deref().unwrap_or("engine_failed"),
            true,
          ));
        }
        output
      }
    };
    if operation.cancelled() {
      return Err(CameraError::new("aborted", CUTOUT_EXPORT_FAILED_MESSAGE));
    }
    let current = verified_photo(&photos, &request.photo_id)?;
    if current.digest != expected_digest {
      return Err(page_failure("internal_error", true));
    }
    Ok((work, ready))
  })
  .await?;

  run_blocking(move || {
    let mut source = fs::File::open(&ready).map_err(|_| page_failure("write_failed", true))?;
    save::write_replacing(&destination, |file| io::copy(&mut source, file).map(|_| ()))?;
    drop(work);
    Ok(json!({ "saved": true, "fileName": saved_name }))
  })
  .await
}

#[cfg(test)]
#[path = "cutout_commands_tests.rs"]
mod tests;
