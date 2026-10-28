//! この Mac の `PhotoLibrary` のうち、現像（作業コピー・原寸の書き出し）。spec `niho-camera-app.md`「段 1・段 2」と「接続口
//! PhotoLibrary」の `open`（作業コピー）・`ensureWorkingCopy`・`export`（native）。
//!
//! 本体は `packages/desktop-photo` の `PhotoDevelop`（NIHO Desktop と同じ関数・同じ sidecar・同じ `baseVersion`）。NIHO photo は
//! `LocalRaster::Camera` で使う: HEIC / HEIF・TIFF・大きな JPEG / PNG の作業コピーは `apple-raw-linear raster`（ワーカー・
//! クラウドと同じ）、JPEG は 64MiB・PNG は 10MiB までオリジナルのまま、HEIC / HEIF・TIFF も原寸で書き出す。
//! sidecar と校正は `.app` の中（`Contents/MacOS/`・`Contents/Resources/develop-calibration/`。NIHO Desktop と同じ場所）。

use crate::error::{invalid_request, parse_request, run_blocking, CameraError};
use crate::photos::{check_photo_id, photos, CameraPhotos};
use crate::{app_log, dialog};
use niho_desktop_photo::common::{code, new_opaque_id};
use niho_desktop_photo::develop::{
  export_input_for, signed_raw_generation_from_var, DevelopConfig, DevelopError, DevelopSourceContext, DevelopTimeouts,
  ExportInput, LocalRaster, Overwrite, PhotoDevelop, SidecarPaths, APPLE_RAW_LINEAR_NAME, CACHE_DIR_NAME,
  CACHE_MAX_BYTES, CALIBRATION_RESOURCE_DIR, DEVELOP_RENDER_NAME, TOKEN_NOT_FOUND_MESSAGE,
};
use niho_desktop_photo::library::is_valid_id;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// macOS のファイル名の上限（UTF-8 のバイト数）。
const MAX_FILE_NAME_BYTES: usize = 255;
const EXPORT_FOLDER_NOT_FOUND_MESSAGE: &str = "書き出し先のフォルダが見つかりません。フォルダを選び直してください。";
const ORIGINAL_OVERWRITE_MESSAGE: &str = "元の写真には上書きできません。別の名前で保存してください。";
const EXPORT_NAME_TAKEN_MESSAGE: &str = "書き出し先に同じ名前のファイルが多すぎます。別のフォルダを選んでください。";
/// フォルダへの書き出しで、同じ名前があるときに試す番号の上限（`-2`〜`-999`）。
const MAX_EXPORT_NUMBER: u32 = 999;

pub struct DevelopState(pub Arc<PhotoDevelop>);

/// 書き出し先に選んだフォルダ（`exportFolderId` → パス。アプリを閉じるまで）。
#[derive(Default)]
pub struct ExportFolders(Mutex<HashMap<String, PathBuf>>);

/// `.app` の中の sidecar と校正の場所。開発ビルドだけ `NIHO_APPLE_RAW_LINEAR_PATH` / `NIHO_DEVELOP_RENDER_PATH` /
/// `NIHO_DEVELOP_CALIBRATION_DIR` で差し替えられる（NIHO Desktop と同じ名前）。
pub fn bundled_sidecar_paths() -> Option<SidecarPaths> {
  let exe = std::env::current_exe().ok()?;
  let macos = exe.parent()?;
  #[allow(unused_mut)]
  let mut paths = SidecarPaths {
    apple_raw_linear: macos.join(APPLE_RAW_LINEAR_NAME),
    develop_render: macos.join(DEVELOP_RENDER_NAME),
    calibration_dir: macos.parent()?.join("Resources").join(CALIBRATION_RESOURCE_DIR),
  };
  #[cfg(debug_assertions)]
  {
    let dev = |name: &str| {
      std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    };
    if let Some(path) = dev("NIHO_APPLE_RAW_LINEAR_PATH") {
      paths.apple_raw_linear = path;
    }
    if let Some(path) = dev("NIHO_DEVELOP_RENDER_PATH") {
      paths.develop_render = path;
    }
    if let Some(path) = dev("NIHO_DEVELOP_CALIBRATION_DIR") {
      paths.calibration_dir = path;
    }
  }
  Some(paths)
}

/// 起動時に 1 回。sidecar が使えるかは裏で 1 回だけ確かめる（画面は `camera_develop_status` で読む）。
pub fn install(app: &tauri::AppHandle) {
  let log = app_log::log_fn(app);
  let signed_raw_generation =
    signed_raw_generation_from_var(std::env::var("NIHO_CAMERA_SIGNED_RAW")).unwrap_or_else(|| {
      log("camera.develop_signed_generation_invalid", json!({ "enabled": false }));
      false
    });
  let config = DevelopConfig {
    sidecars: bundled_sidecar_paths(),
    cache_dir: app.path().app_cache_dir().ok().map(|dir| dir.join(CACHE_DIR_NAME)),
    cache_max_bytes: CACHE_MAX_BYTES,
    timeouts: DevelopTimeouts::default(),
    sips: PathBuf::from("/usr/bin/sips"),
    raster_info: None,
    signed_raw_generation,
    local_raster: LocalRaster::Camera,
    log,
  };
  let develop = PhotoDevelop::new(config);
  app.manage(DevelopState(develop.clone()));
  app.manage(ExportFolders::default());
  std::thread::spawn(move || {
    // 起動時の確かめの一時的な失敗は 1 回だけやり直す
    if !develop.is_available() {
      develop.is_available();
    }
    // 前に落ちた仕事の一時フォルダを片付ける
    develop.sweep_cache(&[]);
  });
}

pub fn develop(app: &tauri::AppHandle) -> Result<Arc<PhotoDevelop>, CameraError> {
  app
    .try_state::<DevelopState>()
    .map(|state| state.0.clone())
    .ok_or_else(|| DevelopError::new(code::ENGINE_UNAVAILABLE, "", "photo develop is not installed").into())
}

/// アプリを閉じるとき（走っている sidecar を止め、書きかけの書き出しを消す）。
pub fn shutdown(app: &tauri::AppHandle) {
  if let Some(state) = app.try_state::<DevelopState>() {
    state.0.shutdown();
  }
}

/// この写真を原寸で書き出せるか（形式と、同梱の sidecar の確かめの結果。確かめている間は false）。
pub fn can_export(develop: &PhotoDevelop, file_name: &str) -> bool {
  match export_input_for(file_name, LocalRaster::Camera) {
    Some(ExportInput::RasterFullSize) => develop.is_full_size_raster_export_available_cached(),
    Some(_) => develop.is_available_cached(),
    None => false,
  }
}

/// 書き出しの名前。画面の案が空・記号だけなら `<元の名前>.jpg`。パスの区切り・制御文字・先頭の `.` を除き、拡張子は
/// .jpg / .jpeg にそろえ、255 バイトに収める。
pub fn export_file_name(suggested: Option<&str>, original_file_name: &str) -> String {
  let stem_of = |name: &str| {
    Path::new(name)
      .file_stem()
      .map(|stem| stem.to_string_lossy().into_owned())
      .unwrap_or_default()
  };
  let raw = suggested
    .map(str::trim)
    .filter(|name| name.chars().any(char::is_alphanumeric))
    .map(str::to_string)
    .unwrap_or_else(|| format!("{}.jpg", stem_of(original_file_name)));
  let extension = if raw.to_lowercase().ends_with(".jpeg") {
    "jpeg"
  } else {
    "jpg"
  };
  let mut stem: String = stem_of(&raw)
    .chars()
    .filter(|ch| *ch != '/' && *ch != '\\' && *ch != ':' && !ch.is_control())
    .collect::<String>()
    .trim()
    .trim_start_matches('.')
    .to_string();
  let budget = MAX_FILE_NAME_BYTES - extension.len() - 1;
  while stem.len() > budget {
    stem.pop();
  }
  if stem.trim().is_empty() {
    stem = "photo".to_string();
  }
  format!("{stem}.{extension}")
}

/// フォルダへの書き出しの名前。`number` が 2 以上なら拡張子の前に `-<number>`。255 バイトに収める。
pub fn numbered_file_name(file_name: &str, number: u32) -> String {
  if number < 2 {
    return file_name.to_string();
  }
  let (stem, extension) = file_name
    .rsplit_once('.')
    .map_or((file_name, ""), |(stem, extension)| (stem, extension));
  let suffix = format!("-{number}");
  let mut stem = stem.to_string();
  while stem.len() + suffix.len() + extension.len() + 1 > MAX_FILE_NAME_BYTES {
    stem.pop();
  }
  format!("{stem}{suffix}.{extension}")
}

/// 書き出しの保存先が開いている写真の元ファイルなら断る（原本は書き換えない。spec 決まりごと 9）。
fn refuse_original(photos: &CameraPhotos, destination: &Path) -> Result<(), CameraError> {
  if photos.is_open_original(destination) {
    Err(CameraError::new(code::EXPORT_FAILED, ORIGINAL_OVERWRITE_MESSAGE))
  } else {
    Ok(())
  }
}

/// 保存ダイアログが返したパスの拡張子を .jpg / .jpeg にそろえる。
fn ensure_jpeg_extension(path: PathBuf) -> PathBuf {
  let is_jpeg = path
    .extension()
    .and_then(|extension| extension.to_str())
    .is_some_and(|extension| matches!(extension.to_lowercase().as_str(), "jpg" | "jpeg"));
  if is_jpeg {
    path
  } else {
    let mut name = path.file_name().map(|name| name.to_os_string()).unwrap_or_default();
    name.push(".jpg");
    path.with_file_name(name)
  }
}

/// フォルダへの書き出し: 同じ名前があれば `-2`… を付けて、上書きせずに書く（書けた名前を返す）。
#[allow(clippy::too_many_arguments)] // command境界の保存状態と出力先を明示的に受け取る。
pub fn export_into_folder(
  develop: &PhotoDevelop,
  photos: &CameraPhotos,
  photo_id: &str,
  develop_settings: &Value,
  has_saved_develop_settings: bool,
  has_develop_edits: bool,
  folder: &Path,
  file_name: &str,
) -> Result<String, CameraError> {
  if !folder.is_dir() {
    return Err(CameraError::new(
      code::FOLDER_NOT_FOUND,
      EXPORT_FOLDER_NOT_FOUND_MESSAGE,
    ));
  }
  for number in 1..=MAX_EXPORT_NUMBER {
    let name = numbered_file_name(file_name, number);
    let destination = folder.join(&name);
    if std::fs::symlink_metadata(&destination).is_ok() {
      continue;
    }
    refuse_original(photos, &destination)?;
    match develop.export_with_saved_state(
      photos,
      photo_id,
      develop_settings,
      has_saved_develop_settings,
      has_develop_edits,
      &destination,
      Overwrite::Never,
    ) {
      Ok(()) => return Ok(name),
      // 書いている間に同じ名前ができた（ほかのアプリ）なら次の番号へ
      Err(err) if err.code == code::EXPORT_FAILED && std::fs::symlink_metadata(&destination).is_ok() => continue,
      Err(err) => return Err(err.into()),
    }
  }
  Err(CameraError::new(code::EXPORT_FAILED, EXPORT_NAME_TAKEN_MESSAGE))
}

// ---------------------------------------------------------------------------
// 引数

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRequest {
  pub photo_id: String,
  /// オリジナルのまま渡せる JPEG / PNG でも作業コピーにする（画面が開いて 4,000 万画素を超えると分かった JPEG）
  #[serde(default)]
  pub force_working_copy: bool,
  #[serde(default)]
  pub source_context: Option<SourceContextRequest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextRequest {
  pub has_saved_develop_settings: bool,
  pub has_develop_edits: bool,
  #[serde(default)]
  pub base_version: Option<String>,
}

impl From<SourceContextRequest> for DevelopSourceContext {
  fn from(context: SourceContextRequest) -> Self {
    Self {
      has_saved_develop_settings: context.has_saved_develop_settings,
      has_develop_edits: context.has_develop_edits,
      base_version: context.base_version,
    }
  }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBytesRequest {
  pub photo_id: String,
  pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequest {
  pub photo_id: String,
  pub develop_settings: Value,
  #[serde(default)]
  pub has_saved_develop_settings: Option<bool>,
  #[serde(default)]
  pub has_develop_edits: Option<bool>,
  #[serde(default)]
  pub suggested_file_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportToFolderRequest {
  pub export_folder_id: String,
  pub photo_id: String,
  pub develop_settings: Value,
  #[serde(default)]
  pub has_saved_develop_settings: Option<bool>,
  #[serde(default)]
  pub has_develop_edits: Option<bool>,
  #[serde(default)]
  pub suggested_file_name: Option<String>,
}

fn check_settings(settings: &Value) -> Result<(), CameraError> {
  if settings.is_object() && serde_json::to_vec(settings).is_ok_and(|bytes| bytes.len() <= 64 * 1024) {
    Ok(())
  } else {
    Err(invalid_request())
  }
}

fn check_suggested_name(name: &Option<String>) -> Result<(), CameraError> {
  match name {
    Some(name) if name.len() > 1024 => Err(invalid_request()),
    _ => Ok(()),
  }
}

/// 保存済みの context は画面から来た値を信用せず、現在の ContentSHA の保存ストアを読み直す。
pub(crate) fn stored_source_context(photos: &CameraPhotos, photo_id: &str) -> Option<DevelopSourceContext> {
  let photo = photos.get(photo_id)?;
  let saved = photos.saved(&photo.digest.key)?;
  Some(DevelopSourceContext {
    has_saved_develop_settings: true,
    // 保存済みであること自体が新規 producer を止める。neutral 判定を Rust 側で複製しない。
    has_develop_edits: true,
    base_version: saved.settings.get("base").and_then(Value::as_str).map(str::to_string),
  })
}

// ---------------------------------------------------------------------------
// コマンド

/// 現像が使えるか（`{ available, raster, fullSizeRaster, masks }`。`fullSizeRaster` は HEIC / HEIF・TIFF も原寸で書き出せる、`masks` は
/// 部分補正（`developSettings.masks`）のある設定を原寸で書き出せる（同梱の niho-develop-render が描ける版）。起動時の
/// 確かめが終わるまで待ってから答える（確かめている間に false を返すと、画面は原寸の書き出し・作業コピーを出さないまま始まる）。
/// 確かめは sidecar ごとに時間の上限がある。
#[tauri::command]
pub async fn camera_develop_status(app: tauri::AppHandle) -> Result<Value, CameraError> {
  let develop = develop(&app)?;
  run_blocking(move || {
    let available = develop.is_available();
    Ok(json!({
      "available": available,
      "raster": available && develop.is_raster_available_cached(),
      "fullSizeRaster": available && develop.is_full_size_raster_export_available_cached(),
      "masks": available && develop.is_masks_export_available_cached(),
    }))
  })
  .await
}

/// 開いた写真の現像の入力（`{ kind: "raster" | "workingCopy", byteLength, baseVersion?, meta?, token }`）。作業コピーが要れば
/// 作る（キャッシュにあれば作り直さない）。バイト列は `camera_develop_source_bytes` で `token` から受け取る。
#[tauri::command]
pub async fn camera_develop_source(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: SourceRequest = parse_request(request)?;
  check_photo_id(&request.photo_id)?;
  let (photos, develop) = (photos(&app)?, develop(&app)?);
  run_blocking(move || {
    let context = stored_source_context(&photos, &request.photo_id)
      .or_else(|| request.source_context.map(DevelopSourceContext::from));
    Ok(develop.source_with_options_context(photos.as_ref(), &request.photo_id, context, request.force_working_copy)?)
  })
  .await
}

/// `camera_develop_source` の `token` のバイト列（オリジナルか作業コピー。1 回限り。raw IPC）。
#[tauri::command]
pub async fn camera_develop_source_bytes(
  app: tauri::AppHandle,
  request: Option<Value>,
) -> Result<tauri::ipc::Response, CameraError> {
  let request: SourceBytesRequest = parse_request(request)?;
  check_photo_id(&request.photo_id)?;
  if request.token.is_empty() || request.token.len() > 128 {
    return Err(CameraError::new(code::NOT_FOUND, TOKEN_NOT_FOUND_MESSAGE));
  }
  let (photos, develop) = (photos(&app)?, develop(&app)?);
  let bytes =
    run_blocking(move || Ok(develop.source_bytes(photos.as_ref(), &request.photo_id, &request.token)?)).await?;
  Ok(tauri::ipc::Response::new(bytes))
}

/// 原寸の JPEG を保存ダイアログで選んだ場所へ書き出す（`{ saved, fileName? }`。閉じたら `{ saved: false }`。パスは返さない）。
#[tauri::command]
pub async fn camera_export(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: ExportRequest = parse_request(request)?;
  check_photo_id(&request.photo_id)?;
  check_settings(&request.develop_settings)?;
  check_suggested_name(&request.suggested_file_name)?;
  let (photos, develop) = (photos(&app)?, develop(&app)?);
  // ダイアログを出す前に、書き出せない写真・使えない sidecar を返す
  let photo = {
    let (photos, develop, photo_id) = (photos.clone(), develop.clone(), request.photo_id.clone());
    run_blocking(move || Ok(develop.check_export(photos.as_ref(), &photo_id)?)).await?
  };
  let file_name = export_file_name(request.suggested_file_name.as_deref(), &photo.file_name);
  let Some(destination) = dialog::save_jpeg(&file_name).await?.map(ensure_jpeg_extension) else {
    return Ok(json!({ "saved": false }));
  };
  refuse_original(&photos, &destination)?;
  let saved_name = destination
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_default();
  run_blocking(move || {
    develop.export_with_saved_state(
      photos.as_ref(),
      &request.photo_id,
      &request.develop_settings,
      request.has_saved_develop_settings.unwrap_or(true),
      request.has_develop_edits.unwrap_or(true),
      &destination,
      Overwrite::Allowed,
    )?;
    Ok(json!({ "saved": true, "fileName": saved_name }))
  })
  .await
}

/// 複数枚の書き出し先のフォルダを選ぶ（`{ exportFolder: { exportFolderId, name } | null }`）。
#[tauri::command]
pub async fn camera_choose_export_folder(app: tauri::AppHandle) -> Result<Value, CameraError> {
  let Some(folder) = dialog::pick_export_folder("書き出し先を選ぶ").await? else {
    return Ok(json!({ "exportFolder": null }));
  };
  let name = folder
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| "フォルダ".into());
  let export_folder_id = new_opaque_id("export");
  let folders = app.try_state::<ExportFolders>().ok_or_else(crate::error::internal)?;
  folders
    .0
    .lock()
    .unwrap_or_else(|poison| poison.into_inner())
    .insert(export_folder_id.clone(), folder);
  Ok(json!({ "exportFolder": { "exportFolderId": export_folder_id, "name": name } }))
}

/// 選んだフォルダへ原寸の JPEG を書き出す（`{ fileName }`。同じ名前があれば `-2`… を付け、上書きしない）。
#[tauri::command]
pub async fn camera_export_to_folder(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: ExportToFolderRequest = parse_request(request)?;
  check_photo_id(&request.photo_id)?;
  check_settings(&request.develop_settings)?;
  check_suggested_name(&request.suggested_file_name)?;
  let not_found = || CameraError::new(code::FOLDER_NOT_FOUND, EXPORT_FOLDER_NOT_FOUND_MESSAGE);
  if !is_valid_id(&request.export_folder_id) {
    return Err(not_found());
  }
  let folder = app
    .try_state::<ExportFolders>()
    .and_then(|folders| {
      folders
        .0
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(&request.export_folder_id)
        .cloned()
    })
    .ok_or_else(not_found)?;
  let (photos, develop) = (photos(&app)?, develop(&app)?);
  run_blocking(move || {
    let photo = develop.check_export(photos.as_ref(), &request.photo_id)?;
    let file_name = export_file_name(request.suggested_file_name.as_deref(), &photo.file_name);
    let written = export_into_folder(
      &develop,
      &photos,
      &request.photo_id,
      &request.develop_settings,
      request.has_saved_develop_settings.unwrap_or(true),
      request.has_develop_edits.unwrap_or(true),
      &folder,
      &file_name,
    )?;
    Ok(json!({ "fileName": written }))
  })
  .await
}

#[cfg(test)]
#[path = "develop_tests.rs"]
mod tests;
