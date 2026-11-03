//! この Mac の `PhotoLibrary` のうち、写真を開く・閉じる・補正を保存する（spec `niho-camera-app.md`「接続口 PhotoLibrary」の
//! `open`・`saveDevelopSettings`、「データ（この Mac）」）。
//!
//! - 開いた写真は `photoId`（不透明な ID）で持つ。キーは写真の中身の SHA-256（`packages/desktop-photo` の `content_digest`）で、
//!   名前を変えても・別のフォルダへ動かしても、同じ写真なら同じ補正が付いてくる。
//! - 補正は `~/Library/Application Support/life.niho.camera/edits/<SHA-256>.json`（crate の `SavedSettingsStore`。版
//!   `revision`・写真の名前・大きさ・更新時刻つき）。NIHO photo では補正が利用者のデータそのものなので、古さ・件数では消さない。
//! - 部分補正のマスク（ブラシ・被写体・空）の面は `~/Library/Application Support/life.niho.camera/mask-surfaces/<写真の SHA-256>/
//!   <面の SHA-256>.png`（crate の `MaskSurfaceStore`。写真 1 枚あたり 64 面まで、上限では保存した補正と名前付き・自動版が参照する面を
//!   残し、参照されない面のうち最後に使ったのが古いものから空ける。補正と同じく古さ・写真の数では消さない）。コマンドは `mask_surfaces.rs`。
//! - 補正の版（niho-photo#42。名前を付けて残した補正と自動の版）は同じフォルダの `<SHA-256>.versions.json`（crate の
//!   `saved_versions.rs`。補正の記録とは別のファイル・別の `revision`）。`camera_photo_versions` で読み、`camera_photo_save_versions`
//!   で配列をまるごと書く。
//! - 現像（`develop.rs`）はここを `DevelopPhotos` として読む（原寸の書き出しは描かれるマスクの面をここから読む）。Photo Bench は
//!   持たない（ラスタの作業コピーは `apple-raw-linear raster`）。

use crate::error::{camera_code, invalid_request, parse_request, run_blocking, CameraError};
use crate::library::library;
use niho_desktop_photo::capabilities::{validate_photo, CapabilityStage};
use niho_desktop_photo::common::{code, new_opaque_id, PageError};
use niho_desktop_photo::develop::{DevelopPhotos, OpenPhoto};
use niho_desktop_photo::image_info::{read_photo_info, PhotoInfo};
use niho_desktop_photo::library::{is_valid_id, iso8601_utc, photo_kind, LISTED_PHOTO_NOT_FOUND_MESSAGE};
use niho_desktop_photo::mask_surfaces::{
  mask_surface_ids, MaskSurfaceError, MaskSurfaceInfo, MaskSurfaceLimits, MaskSurfaceStore, MASK_SURFACES_DIR_NAME,
};
use niho_desktop_photo::saved_settings::{
  content_digest, epoch_ms, is_valid_develop_versions, ContentDigest, RecordSource, SaveRevision, SavedRecord,
  SavedSettingsStore, StoreLimits, MAX_SAVED_SETTINGS_BYTES,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// 一度に開ける写真の数（一覧で選んだ写真をまとめて開く・書き出す）。
pub const MAX_PHOTOS_PER_OPEN: usize = 50;
/// 開いたままにしておく写真の数。超えたら古く開いたものから閉じる（`photoId` は使えなくなり、開き直す）。
pub const MAX_OPEN_PHOTOS: usize = 1_000;
/// 補正の置き場（`<app data>/edits`）。
pub const EDITS_DIR_NAME: &str = "edits";

const PHOTO_UNREADABLE_MESSAGE: &str = "写真を読めませんでした。ファイルを確かめてください。";
const SAVE_FAILED_MESSAGE: &str = "補正を保存できませんでした。";
pub(crate) const MASK_SURFACE_INVALID_MESSAGE: &str = "マスクを保存できませんでした。もう一度描いてください。";
const MASK_SURFACE_MISSING_MESSAGE: &str = "マスクの面が見つかりません。マスクを描き直してください。";
const MASK_SURFACE_QUOTA_MESSAGE: &str =
  "この写真にはこれ以上マスクを保存できません。使わないマスクや保存版を整理してからもう一度お試しください。";
const MASK_SURFACE_SAVE_FAILED_MESSAGE: &str = "マスクを保存できませんでした。";
const VERSIONS_SAVE_FAILED_MESSAGE: &str = "版を保存できませんでした。";

/// 補正の置き場の上限: 消さない（古さ・件数で消すと利用者の補正が無くなる）。途中で落ちた一時ファイルの掃除は 1 日ごと。
pub fn edits_limits() -> StoreLimits {
  StoreLimits {
    max_entries: usize::MAX,
    max_age: Duration::MAX,
    sweep_interval: Duration::from_secs(24 * 60 * 60),
  }
}

/// 開いた写真（パス・中身は画面へ渡さない）。
#[derive(Debug, Clone)]
pub struct OpenedPhoto {
  pub entry_id: String,
  pub path: PathBuf,
  pub file_name: String,
  pub digest: ContentDigest,
  pub modified_at_ms: Option<u64>,
}

#[derive(Default)]
struct Opened {
  photos: HashMap<String, OpenedPhoto>,
  order: VecDeque<String>,
}

/// 一覧の写真を開かずに「補正済み」を見分ける索引の鍵（名前・大きさ・一覧の `modifiedAt` と同じ形の更新時刻）。中身の SHA-256 を
/// 読まずに済むよう、保存した補正の記録の `fileName`・`sizeBytes`・`modifiedAtMs` から作る。名前も見るのは、SD カード（更新時刻が
/// 2 秒刻み）の連写の非圧縮 RAW のように、大きさと更新時刻が同じ別の写真があるため。名前を変えた写真は開くまで印が付かない
/// （開けば中身の SHA-256 で補正が付いてくる）。
type EditedKey = (String, u64, String);

fn edited_key(file_name: &str, size_bytes: u64, modified_at_ms: u64) -> EditedKey {
  (
    file_name.to_string(),
    size_bytes,
    iso8601_utc(UNIX_EPOCH + Duration::from_millis(modified_at_ms)),
  )
}

/// 開いた写真と補正・マスクの面の置き場（アプリに 1 つ）。
pub struct CameraPhotos {
  opened: Mutex<Opened>,
  edits: Option<SavedSettingsStore>,
  /// 部分補正のマスクの面（{@link CameraPhotos::with_mask_surfaces}。無ければ面を保存・読み出しできない）
  surfaces: Option<MaskSurfaceStore>,
  /// {@link EditedKey} の索引（最初に一覧を出すときに記録から作り、保存のたびに足す）
  edited: Mutex<Option<HashSet<EditedKey>>>,
}

impl CameraPhotos {
  pub fn new(edits: Option<SavedSettingsStore>) -> Self {
    Self {
      opened: Mutex::new(Opened::default()),
      edits,
      surfaces: None,
      edited: Mutex::new(None),
    }
  }

  /// マスクの面の置き場を持たせる。
  pub fn with_mask_surfaces(mut self, surfaces: MaskSurfaceStore) -> Self {
    self.surfaces = Some(surfaces);
    self
  }

  fn edited_lock(&self) -> MutexGuard<'_, Option<HashSet<EditedKey>>> {
    self.edited.lock().unwrap_or_else(|poison| poison.into_inner())
  }

  /// 一覧の木（`{ folderId, …, children, photos }` か `{ folders, photos }`）の写真に `hasEdits` を付ける（spec「接続口
  /// PhotoLibrary」の `list` の `hasEdits`）。保存した補正の記録の大きさと更新時刻で見分ける。
  pub fn annotate_has_edits(&self, value: &mut Value) {
    let mut edited = self.edited_lock();
    let index = edited.get_or_insert_with(|| {
      self
        .edits
        .as_ref()
        .map(SavedSettingsStore::records)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|record| {
          Some(edited_key(
            &record.file_name,
            record.size_bytes?,
            record.modified_at_ms?,
          ))
        })
        .collect()
    });
    annotate(value, index);
  }

  fn lock(&self) -> MutexGuard<'_, Opened> {
    self.opened.lock().unwrap_or_else(|poison| poison.into_inner())
  }

  /// 写真を開く（中身の SHA-256 を読む）。ふつうのファイルでない・読めないときは Err。
  #[cfg(test)]
  pub fn open(&self, entry_id: &str, path: &Path) -> Result<(String, OpenedPhoto), CameraError> {
    self.open_measured(entry_id, path, |_| {})
  }

  fn open_measured(
    &self,
    entry_id: &str,
    path: &Path,
    hashed: impl FnOnce(Duration),
  ) -> Result<(String, OpenedPhoto), CameraError> {
    let unreadable = || CameraError::new(code::NOT_FOUND, PHOTO_UNREADABLE_MESSAGE);
    let metadata = std::fs::metadata(path).map_err(|_| unreadable())?;
    if !metadata.is_file() {
      return Err(unreadable());
    }
    validate_photo(path, CapabilityStage::Decoder).map_err(CameraError::from)?;
    let started = Instant::now();
    let digest = content_digest(path).map_err(|_| unreadable())?;
    hashed(started.elapsed());
    let photo = OpenedPhoto {
      entry_id: entry_id.to_string(),
      path: path.to_path_buf(),
      file_name: path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default(),
      digest,
      modified_at_ms: metadata.modified().ok().map(epoch_ms),
    };
    let photo_id = new_opaque_id("photo");
    let mut opened = self.lock();
    opened.photos.insert(photo_id.clone(), photo.clone());
    opened.order.push_back(photo_id.clone());
    while opened.order.len() > MAX_OPEN_PHOTOS {
      if let Some(oldest) = opened.order.pop_front() {
        opened.photos.remove(&oldest);
      }
    }
    Ok((photo_id, photo))
  }

  pub fn close(&self, photo_ids: &[String]) {
    let mut opened = self.lock();
    for photo_id in photo_ids {
      opened.photos.remove(photo_id);
    }
    opened.order.retain(|photo_id| !photo_ids.contains(photo_id));
  }

  pub fn get(&self, photo_id: &str) -> Option<OpenedPhoto> {
    self.lock().photos.get(photo_id).cloned()
  }

  /// Resolve the public library entry ID to the newest still-open native photo ID.
  pub(crate) fn find_by_entry_id(&self, entry_id: &str) -> Option<(String, OpenedPhoto)> {
    let opened = self.lock();
    opened.order.iter().rev().find_map(|photo_id| {
      let photo = opened.photos.get(photo_id)?;
      (photo.entry_id == entry_id).then(|| (photo_id.clone(), photo.clone()))
    })
  }

  /// 開いた後も元ファイルが同じ中身かを SHA-256 で確かめて返す。背景除去のようにパスを native の道具へ渡す直前・直後に使い、
  /// Finder などで置き換わった写真へ古いマスクや結果を保存しない。
  pub fn verified(&self, photo_id: &str) -> Result<OpenedPhoto, CameraError> {
    let unreadable = || CameraError::from(PageError::new(code::NOT_FOUND, LISTED_PHOTO_NOT_FOUND_MESSAGE));
    let photo = self.get(photo_id).ok_or_else(unreadable)?;
    let current = content_digest(&photo.path).map_err(|_| unreadable())?;
    if current != photo.digest {
      return Err(unreadable());
    }
    Ok(photo)
  }

  /// `destination` が開いている写真の元ファイルか（同じファイル = 同じ装置・inode。大文字小文字の違う名前・別名のリンクも同じ
  /// ファイルとみなす）。まだ無いファイルは false。保存・書き出しで原本を書き換えないために使う（spec 決まりごと 9）。
  pub fn is_open_original(&self, destination: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(target) = std::fs::metadata(destination) else {
      return false;
    };
    let paths: Vec<PathBuf> = self.lock().photos.values().map(|photo| photo.path.clone()).collect();
    paths.iter().any(|path| {
      std::fs::metadata(path).is_ok_and(|original| original.dev() == target.dev() && original.ino() == target.ino())
    })
  }

  /// 開いた写真の情報（{@link info_json}。右パネルの「情報」。niho-photo#43）。元ファイルの EXIF などを都度読む（覚えない）。
  /// 読めない項目は null で、読めないファイルも失敗にしない。開いていない写真は `notFound`（画面は開き直す）。
  pub fn info(&self, photo_id: &str) -> Result<Value, CameraError> {
    let photo = self
      .get(photo_id)
      .ok_or_else(|| CameraError::from(PageError::new(code::NOT_FOUND, LISTED_PHOTO_NOT_FOUND_MESSAGE)))?;
    Ok(info_json(&read_photo_info(&photo.path)))
  }

  /// 保存した補正（無い・読めないときは None）。
  pub fn saved(&self, key: &str) -> Option<SavedRecord> {
    self.edits.as_ref()?.load_record(key)
  }

  /// 補正を版つきで保存する（{@link SavedSettingsStore::save_revision}）。新しい版を返す。
  pub fn save(
    &self,
    photo_id: &str,
    settings: &Value,
    expected_revision: u64,
    now: SystemTime,
  ) -> Result<u64, CameraError> {
    let photo = self
      .get(photo_id)
      .ok_or_else(|| CameraError::from(PageError::new(code::NOT_FOUND, LISTED_PHOTO_NOT_FOUND_MESSAGE)))?;
    let store = self
      .edits
      .as_ref()
      .ok_or_else(|| CameraError::new(code::INTERNAL, SAVE_FAILED_MESSAGE))?;
    let source = RecordSource {
      file_name: &photo.file_name,
      size_bytes: photo.digest.size_bytes,
      modified_at_ms: photo.modified_at_ms,
    };
    match store.save_revision(&photo.digest.key, &source, settings, expected_revision, now) {
      Ok(SaveRevision::Saved { revision, .. }) => {
        if let (Some(index), Some(modified_at_ms)) = (self.edited_lock().as_mut(), photo.modified_at_ms) {
          index.insert(edited_key(&photo.file_name, photo.digest.size_bytes, modified_at_ms));
        }
        Ok(revision)
      }
      Ok(SaveRevision::Conflict { current }) => Err(CameraError::revision_conflict(current)),
      Err(_) => Err(CameraError::new(code::INTERNAL, SAVE_FAILED_MESSAGE)),
    }
  }

  /// 開いた写真の補正の版の配列と保存の番号（`{ versions, revision }`。niho-photo#42）。版のファイルが無い・読めない写真は
  /// `{ versions: [], revision: 0 }`
  /// （版の無い今までの写真と同じ）。開いていない写真は `notFound`（画面は開き直す）。
  pub fn versions(&self, photo_id: &str) -> Result<Value, CameraError> {
    let photo = self
      .get(photo_id)
      .ok_or_else(|| CameraError::from(PageError::new(code::NOT_FOUND, LISTED_PHOTO_NOT_FOUND_MESSAGE)))?;
    let saved = self
      .edits
      .as_ref()
      .and_then(|store| store.load_versions(&photo.digest.key));
    Ok(match saved {
      Some(saved) => json!({ "versions": saved.versions, "revision": saved.revision }),
      None => json!({ "versions": [], "revision": 0 }),
    })
  }

  /// 補正の版の配列をまるごと保存する（{@link SavedSettingsStore::save_versions}）。新しい `revision` を返す。画面が知っている番号と違えば
  /// `revisionConflict`。鍵は開いたときの中身の SHA-256（補正と同じ）。
  pub fn save_versions(
    &self,
    photo_id: &str,
    versions: &Value,
    expected_revision: u64,
    now: SystemTime,
  ) -> Result<u64, CameraError> {
    let photo = self
      .get(photo_id)
      .ok_or_else(|| CameraError::from(PageError::new(code::NOT_FOUND, LISTED_PHOTO_NOT_FOUND_MESSAGE)))?;
    let store = self
      .edits
      .as_ref()
      .ok_or_else(|| CameraError::new(code::INTERNAL, VERSIONS_SAVE_FAILED_MESSAGE))?;
    match store.save_versions(&photo.digest.key, versions, expected_revision, now) {
      Ok(SaveRevision::Saved { revision, .. }) => Ok(revision),
      Ok(SaveRevision::Conflict { current }) => Err(CameraError::revision_conflict(current)),
      Err(err) if err.kind() == std::io::ErrorKind::InvalidInput => Err(invalid_request()),
      Err(_) => Err(CameraError::new(code::INTERNAL, VERSIONS_SAVE_FAILED_MESSAGE)),
    }
  }
}

// ---------------------------------------------------------------------------
// マスクの面

fn mask_surface_error(error: MaskSurfaceError) -> CameraError {
  match error {
    MaskSurfaceError::InvalidId => invalid_request(),
    MaskSurfaceError::InvalidPng(_) | MaskSurfaceError::TooLarge => {
      CameraError::new(camera_code::MASK_SURFACE_INVALID, MASK_SURFACE_INVALID_MESSAGE)
    }
    MaskSurfaceError::QuotaExceeded => CameraError::new(camera_code::MASK_SURFACE_QUOTA, MASK_SURFACE_QUOTA_MESSAGE),
    MaskSurfaceError::NotFound | MaskSurfaceError::Corrupt => {
      CameraError::new(camera_code::MASK_SURFACE_MISSING, MASK_SURFACE_MISSING_MESSAGE)
    }
    MaskSurfaceError::Io(_) => CameraError::new(code::INTERNAL, MASK_SURFACE_SAVE_FAILED_MESSAGE),
  }
}

impl CameraPhotos {
  fn opened_photo(&self, photo_id: &str) -> Result<OpenedPhoto, CameraError> {
    self
      .get(photo_id)
      .ok_or_else(|| CameraError::from(PageError::new(code::NOT_FOUND, LISTED_PHOTO_NOT_FOUND_MESSAGE)))
  }

  fn surface_store(&self) -> Result<&MaskSurfaceStore, CameraError> {
    self
      .surfaces
      .as_ref()
      .ok_or_else(|| CameraError::new(code::INTERNAL, MASK_SURFACE_SAVE_FAILED_MESSAGE))
  }

  /// 開いた写真のマスクの面を保存する（`png` は 8bit グレーの PNG。id は中身の SHA-256）。上限では、現在の保存済み補正と名前付き・
  /// 自動版が参照する面を残して、最後に使ったのが古い面から空ける。
  pub fn save_mask_surface(&self, photo_id: &str, png: &[u8], now: SystemTime) -> Result<MaskSurfaceInfo, CameraError> {
    let photo = self.opened_photo(photo_id)?;
    let store = self.surface_store()?;
    let mut keep: std::collections::BTreeSet<String> = self
      .saved(&photo.digest.key)
      .map(|record| mask_surface_ids(&record.settings, false))
      .unwrap_or_default()
      .into_iter()
      .collect();
    if let Some(versions) = self
      .edits
      .as_ref()
      .and_then(|store| store.load_versions(&photo.digest.key))
    {
      if let Some(items) = versions.versions.as_array() {
        for version in items {
          keep.extend(mask_surface_ids(&version["developSettings"], false));
        }
      }
    }
    store
      .save(&photo.digest.key, png, &keep, now)
      .map_err(mask_surface_error)
  }

  /// 開いた写真のマスクの面の PNG（中身の SHA-256 を `surface_id` と照らしたもの）。
  pub fn load_mask_surface(&self, photo_id: &str, surface_id: &str, now: SystemTime) -> Result<Vec<u8>, CameraError> {
    let photo = self.opened_photo(photo_id)?;
    self
      .surface_store()?
      .load(&photo.digest.key, surface_id, now)
      .map_err(mask_surface_error)
  }

  /// `surface_ids` のうち、開いた写真の面の置き場に無いもの（渡した順）。
  pub fn missing_mask_surfaces(&self, photo_id: &str, surface_ids: &[String]) -> Result<Vec<String>, CameraError> {
    let photo = self.opened_photo(photo_id)?;
    let store = self.surface_store()?;
    Ok(
      surface_ids
        .iter()
        .filter(|id| !store.contains(&photo.digest.key, id))
        .cloned()
        .collect(),
    )
  }
}

/// マスクの面の置き場の上限（1 枚あたり 64 面・1 面 8 MiB）。
pub fn mask_surface_limits() -> MaskSurfaceLimits {
  MaskSurfaceLimits::default()
}

impl DevelopPhotos for CameraPhotos {
  fn open_photo(&self, photo_id: &str) -> Option<OpenPhoto> {
    self.get(photo_id).map(|photo| OpenPhoto {
      path: photo.path,
      file_name: photo.file_name,
      digest: photo.digest,
    })
  }

  fn has_saved_settings(&self, photo_id: &str) -> bool {
    match (self.get(photo_id), self.edits.as_ref()) {
      (Some(photo), Some(store)) => store.contains_record(&photo.digest.key),
      // 写真・保存先の状態が分からないときは「保存あり」（crate の約束）
      _ => true,
    }
  }

  fn mask_surface(&self, photo_id: &str, surface_id: &str) -> Option<Vec<u8>> {
    self.load_mask_surface(photo_id, surface_id, SystemTime::now()).ok()
  }
}

fn annotate(value: &mut Value, index: &HashSet<EditedKey>) {
  let Some(object) = value.as_object_mut() else { return };
  if let Some(Value::Array(photos)) = object.get_mut("photos") {
    for photo in photos.iter_mut() {
      let key = (|| {
        Some((
          photo.get("fileName")?.as_str()?.to_string(),
          photo.get("sizeBytes")?.as_u64()?,
          photo.get("modifiedAt")?.as_str()?.to_string(),
        ))
      })();
      if let Some(entry) = photo.as_object_mut() {
        entry.insert("hasEdits".into(), json!(key.is_some_and(|key| index.contains(&key))));
      }
    }
  }
  for list in ["children", "folders"] {
    if let Some(Value::Array(folders)) = object.get_mut(list) {
      folders.iter_mut().for_each(|folder| annotate(folder, index));
    }
  }
}

pub struct PhotosState(pub Arc<CameraPhotos>);

pub fn install(app: &tauri::AppHandle) {
  let data = app.path().app_data_dir().ok();
  let edits = data
    .as_ref()
    .map(|dir| SavedSettingsStore::new(dir.join(EDITS_DIR_NAME), edits_limits()));
  let mut photos = CameraPhotos::new(edits);
  if let Some(dir) = data {
    photos = photos.with_mask_surfaces(MaskSurfaceStore::new(
      dir.join(MASK_SURFACES_DIR_NAME),
      mask_surface_limits(),
    ));
  }
  app.manage(PhotosState(Arc::new(photos)));
}

pub fn photos(app: &tauri::AppHandle) -> Result<Arc<CameraPhotos>, CameraError> {
  app
    .try_state::<PhotosState>()
    .map(|state| state.0.clone())
    .ok_or_else(crate::error::internal)
}

/// 写真の形式（画面の道具と文言の出し分け用）: `raw`・`jpeg`・`png`・`heic`・`tiff`。写真の拡張子でなければ None。
pub fn photo_format(file_name: &str) -> Option<&'static str> {
  if photo_kind(file_name)? == "raw" {
    return Some("raw");
  }
  let extension = file_name.rsplit_once('.')?.1.to_lowercase();
  match extension.as_str() {
    "jpg" | "jpeg" => Some("jpeg"),
    "png" => Some("png"),
    "heic" | "heif" => Some("heic"),
    "tif" | "tiff" => Some("tiff"),
    _ => None,
  }
}

pub fn check_photo_id(photo_id: &str) -> Result<(), CameraError> {
  if is_valid_id(photo_id) {
    Ok(())
  } else {
    Err(PageError::new(code::NOT_FOUND, LISTED_PHOTO_NOT_FOUND_MESSAGE).into())
  }
}

// ---------------------------------------------------------------------------
// 引数

/// `camera_photo_open` の引数（1〜50 個の `entryId`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest {
  pub entry_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseRequest {
  pub photo_ids: Vec<String>,
}

/// `camera_photo_info` の引数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InfoRequest {
  pub photo_id: String,
}

/// `camera_photo_save_settings` の引数。`expectedRevision` は画面が知っている版（保存したことが無ければ 0）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSettingsRequest {
  pub photo_id: String,
  pub develop_settings: Value,
  pub expected_revision: u64,
}

/// `camera_photo_versions` の引数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionsRequest {
  pub photo_id: String,
}

/// `camera_photo_save_versions` の引数。`versions` は版の配列まるごと、`expectedRevision` は画面が知っている保存の番号（版のファイルが
/// 無ければ 0）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveVersionsRequest {
  pub photo_id: String,
  pub versions: Value,
  pub expected_revision: u64,
}

pub fn validate_save_versions_request(request: &SaveVersionsRequest) -> Result<(), CameraError> {
  check_photo_id(&request.photo_id)?;
  if !is_valid_develop_versions(&request.versions) {
    return Err(invalid_request());
  }
  Ok(())
}

pub fn validate_open_request(request: &OpenRequest) -> Result<(), CameraError> {
  if request.entry_ids.is_empty() || request.entry_ids.len() > MAX_PHOTOS_PER_OPEN {
    return Err(invalid_request());
  }
  Ok(())
}

pub fn validate_save_settings_request(request: &SaveSettingsRequest) -> Result<(), CameraError> {
  check_photo_id(&request.photo_id)?;
  let size = serde_json::to_vec(&request.develop_settings)
    .map(|bytes| bytes.len())
    .unwrap_or(usize::MAX);
  if !request.develop_settings.is_object() || size > MAX_SAVED_SETTINGS_BYTES {
    return Err(invalid_request());
  }
  Ok(())
}

/// 開いた写真を画面へ返す形（`saved` は保存した補正。無ければ null）。`contentSha256` は中身の SHA-256（16 進の小文字 64 文字。
/// 補正の置き場の鍵と同じ。接続口 `PhotoLibrary` の `contentSha256`）、`modifiedAt` はファイルの更新日時（一覧の `modifiedAt` と
/// 同じ形。読めなければ null）。
pub fn opened_json(photo_id: &str, photo: &OpenedPhoto, saved: Option<SavedRecord>, native_export: bool) -> Value {
  json!({
    "photoId": photo_id,
    "entryId": photo.entry_id,
    "fileName": photo.file_name,
    "format": photo_format(&photo.file_name),
    "sizeBytes": photo.digest.size_bytes,
    "contentSha256": photo.digest.key,
    "modifiedAt": photo.modified_at_ms.map(|ms| iso8601_utc(UNIX_EPOCH + Duration::from_millis(ms))),
    "nativeExport": native_export,
    "saved": saved.map(|record| json!({
      "developSettings": record.settings,
      "revision": record.revision,
      "updatedAtMs": record.updated_at_ms,
    })),
  })
}

/// 写真の情報を画面へ返す形（接続口 `PhotoLibrary.info` の `PhotoLibraryPhotoInfo`）。読めなかった項目は null。`capturedAt` は
/// 撮影した場所の時計のまま（時差なし）、`width`・`height` は向きを反映した寸法、`gps` は 10 進の度（南緯・西経は負）。
pub fn info_json(info: &PhotoInfo) -> Value {
  json!({
    "camera": (info.make.is_some() || info.model.is_some()).then(|| json!({ "make": info.make, "model": info.model })),
    "lens": info.lens,
    "iso": info.iso,
    "exposureTimeSeconds": info.exposure_time_seconds,
    "fNumber": info.f_number,
    "focalLengthMm": info.focal_length_mm,
    "capturedAt": info.captured_at,
    "width": info.dimensions.map(|(width, _)| width),
    "height": info.dimensions.map(|(_, height)| height),
    "gps": info.gps.map(|gps| json!({ "latitude": gps.latitude, "longitude": gps.longitude })),
  })
}

// ---------------------------------------------------------------------------
// コマンド

/// 一覧で選んだ写真を開く（`{ photos, failed }`）。`photos` は開いた順、`failed` は開けなかった `entryId` と code・文。
#[tauri::command]
pub async fn camera_photo_open(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: OpenRequest = parse_request(request)?;
  validate_open_request(&request)?;
  let library = library(&app)?;
  let photos = photos(&app)?;
  let develop = crate::develop::develop(&app).ok();
  let log = crate::app_log::log_fn(&app);
  run_blocking(move || {
    let mut opened = Vec::new();
    let mut failed = Vec::new();
    for listed in library.listed_photos(request.entry_ids) {
      let result = listed
        .path
        .ok_or_else(|| PageError::new(code::NOT_FOUND, LISTED_PHOTO_NOT_FOUND_MESSAGE).into())
        .and_then(|path| {
          photos.open_measured(&listed.entry_id, &path, |elapsed| {
            log(
              "camera.photo_stage",
              json!({ "stage": "nativeHash", "elapsedMs": elapsed.as_secs_f64() * 1000.0 }),
            );
          })
        });
      match result {
        Ok((photo_id, photo)) => {
          let native_export = develop
            .as_ref()
            .is_some_and(|develop| crate::develop::can_export(develop, &photo.file_name));
          opened.push(opened_json(
            &photo_id,
            &photo,
            photos.saved(&photo.digest.key),
            native_export,
          ));
        }
        Err(err) => failed.push(json!({ "entryId": listed.entry_id, "code": err.code, "message": err.message })),
      }
    }
    Ok(json!({ "photos": opened, "failed": failed }))
  })
  .await
}

/// 開いた写真を閉じる（`{}`。知らない `photoId` は黙って飛ばす）。
#[tauri::command]
pub async fn camera_photo_close(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: CloseRequest = parse_request(request)?;
  if request.photo_ids.len() > MAX_OPEN_PHOTOS {
    return Err(invalid_request());
  }
  photos(&app)?.close(&request.photo_ids);
  Ok(json!({}))
}

/// 開いた写真の情報（`{ info }`。右パネルの「情報」。niho-photo#43）。元ファイルを ImageIO で読む（画素は展開しない・書かない）。
#[tauri::command]
pub async fn camera_photo_info(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: InfoRequest = parse_request(request)?;
  check_photo_id(&request.photo_id)?;
  let photos = photos(&app)?;
  run_blocking(move || Ok(json!({ "info": photos.info(&request.photo_id)? }))).await
}

/// 補正を保存する（`{ revision }`）。画面が知っている版と違えば `revisionConflict`（`currentRevision` に今の版）。
#[tauri::command]
pub async fn camera_photo_save_settings(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: SaveSettingsRequest = parse_request(request)?;
  validate_save_settings_request(&request)?;
  let photos = photos(&app)?;
  run_blocking(move || {
    let revision = photos.save(
      &request.photo_id,
      &request.develop_settings,
      request.expected_revision,
      SystemTime::now(),
    )?;
    Ok(json!({ "revision": revision }))
  })
  .await
}

/// 開いた写真の補正の版（`{ versions, revision }`。右パネルの「版」。niho-photo#42）。
#[tauri::command]
pub async fn camera_photo_versions(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: VersionsRequest = parse_request(request)?;
  check_photo_id(&request.photo_id)?;
  let photos = photos(&app)?;
  run_blocking(move || photos.versions(&request.photo_id)).await
}

/// 補正の版の配列をまるごと保存する（`{ revision }`）。画面が知っている番号と違えば `revisionConflict`（`currentRevision` に今の番号）。
#[tauri::command]
pub async fn camera_photo_save_versions(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: SaveVersionsRequest = parse_request(request)?;
  validate_save_versions_request(&request)?;
  let photos = photos(&app)?;
  run_blocking(move || {
    let revision = photos.save_versions(
      &request.photo_id,
      &request.versions,
      request.expected_revision,
      SystemTime::now(),
    )?;
    Ok(json!({ "revision": revision }))
  })
  .await
}

#[cfg(test)]
#[path = "photos_tests.rs"]
mod tests;
